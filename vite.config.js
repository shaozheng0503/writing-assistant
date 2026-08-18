import { defineConfig, loadEnv } from 'vite';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { spawn } from 'child_process';

/**
 * LLM CORS 代理插件
 * 浏览器直接调 LLM API 会被 CORS 拦截，dev server 做一层中转。
 * 前端请求 /llm-proxy?target=URL，服务端转发并流式回传。
 */
function llmProxyPlugin() {
  return {
    name: 'llm-proxy',
    configureServer(server) {
      server.middlewares.use('/llm-proxy', async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const target = url.searchParams.get('target');
        if (!target) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing target param' }));
          return;
        }

        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);

        try {
          const response = await fetch(target, {
            method: req.method || 'POST',
            headers: {
              'content-type': req.headers['content-type'] || 'application/json',
              ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
            },
            body: body.length > 0 ? body : undefined,
          });

          res.statusCode = response.status;
          response.headers.forEach((v, k) => {
            if (!['transfer-encoding', 'content-encoding', 'content-length'].includes(k.toLowerCase())) {
              res.setHeader(k, v);
            }
          });

          const reader = response.body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
            res.end();
          };
          pump().catch((e) => {
            if (!res.writableEnded) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        } catch (e) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },
  };
}

/**
 * Imagifly 代理插件
 * 浏览器直接调 imagifly.net 会被 CORS 拦截，且 cookie 不能暴露给前端。
 * dev server 做一层中转：前端 POST /imagifly-proxy/submit → 服务端注入 cookie 转发
 * 前端 GET /imagifly-proxy/poll?id=xxx → 服务端注入 cookie 轮询
 * 前端 GET /imagifly-proxy/image?url=xxx → 服务端注入 cookie 下载图片
 */
function imagiflyProxyPlugin(cookie) {
  const BASE = 'https://imagifly.net';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  return {
    name: 'imagifly-proxy',
    configureServer(server) {
      // 提交生图请求（带 1 次自动重试：Imagifly 偶发 5xx/网络抖动）
      server.middlewares.use('/imagifly-proxy/submit', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        let parsed;
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          parsed = JSON.parse(Buffer.concat(chunks).toString());
        } catch (e) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: `Bad request body: ${e.message}` }));
          return;
        }
        const { prompt, model, size, imageCount } = parsed;
        const payload = JSON.stringify({
          prompt,
          model: model || 'nano-banana-2',
          size: size || '1368x768',
          imageCount: imageCount || 1,
        });

        const doSubmit = () =>
          fetch(`${BASE}/api/images/generate`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Cookie': cookie,
              'Referer': `${BASE}/zh/create`,
              'User-Agent': UA,
              'Accept': 'application/json, */*',
            },
            body: payload,
          });

        try {
          let apiRes = await doSubmit();
          // 5xx / 网络错误重试一次（间隔 3s）；4xx 不重试（请求本身有问题）
          if (apiRes.status >= 500) {
            await new Promise((r) => setTimeout(r, 3000));
            apiRes = await doSubmit();
          }
          const apiText = await apiRes.text();
          let apiJson;
          try { apiJson = JSON.parse(apiText); } catch { apiJson = { raw: apiText }; }

          // 提取 generation id
          let gid = null;
          if (apiJson.generation) {
            if (typeof apiJson.generation === 'object') {
              gid = apiJson.generation.id;
            }
          }

          if (!gid) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: 'No generation id', detail: apiJson }));
            return;
          }

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ gid }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      // 轮询生成状态
      server.middlewares.use('/imagifly-proxy/poll', async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const gid = url.searchParams.get('id');
        if (!gid) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing id param' }));
          return;
        }
        try {
          const apiRes = await fetch(`${BASE}/api/generations/${gid}`, {
            headers: {
              'Cookie': cookie,
              'Referer': `${BASE}/zh/create`,
              'User-Agent': UA,
              'Accept': 'application/json, */*',
            },
          });
          const apiText = await apiRes.text();
          let apiJson;
          try { apiJson = JSON.parse(apiText); } catch { apiJson = { raw: apiText }; }

          let status = 'pending';
          let imageUrl = null;
          let imageUrls = null; // imageCount > 1 时全部图片 URL
          let error = null;

          if (apiJson.generation && typeof apiJson.generation === 'object') {
            status = apiJson.generation.status || 'pending';
            if (status === 'success') {
              const assets = apiJson.generation.assets || [];
              if (assets.length > 0) {
                imageUrl = assets[0].url;
                imageUrls = assets.map((a) => a.url).filter(Boolean);
              }
            } else if (status === 'failed') {
              error = apiJson.generation.error || apiJson.error || 'failed';
            }
          } else if (typeof apiJson.generation === 'string') {
            status = 'pending'; // generation 字段为字符串说明还在处理
          }

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ status, imageUrl, imageUrls, error }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      // 下载图片（转发 asset URL，注入 cookie）；加 save=1 同时落盘到 saved-images/
      server.middlewares.use('/imagifly-proxy/image', async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const target = url.searchParams.get('url');
        const wantSave = url.searchParams.get('save') === '1';
        if (!target) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing url param' }));
          return;
        }
        try {
          const imgRes = await fetch(target, {
            headers: {
              'Cookie': cookie,
              'Referer': `${BASE}/zh/create`,
              'User-Agent': UA,
            },
          });
          const buf = Buffer.from(await imgRes.arrayBuffer());

          // 文件头嗅探
          let ct = imgRes.headers.get('content-type') || 'image/png';
          let ext = 'png';
          if (buf[0] === 0xff && buf[1] === 0xd8) { ct = 'image/jpeg'; ext = 'jpg'; }
          else if (buf[0] === 0x89 && buf[1] === 0x50) { ct = 'image/png'; ext = 'png'; }
          else if (buf[0] === 0x47 && buf[1] === 0x49) { ct = 'image/gif'; ext = 'gif'; }
          else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) { ct = 'image/webp'; ext = 'webp'; }

          // 落盘：saved-images/[folder/]序号-摘要.扩展名（folder=文章文件夹；失败不影响回传）
          let savedName = '';
          if (wantSave) {
            try {
              const folder = (url.searchParams.get('folder') || '').replace(/[\\/:*?"<>|]+/g, '').substring(0, 50);
              const dir = resolve(process.cwd(), 'saved-images', ...((folder && folder.length > 0 && folder !== '.') ? [folder] : []));
              if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
              const cap = (url.searchParams.get('caption') || '').replace(/[\\/:*?"<>|\s]+/g, '').substring(0, 24);
              const stamp = new Date().toISOString().replace(/[-:T]/g, '').substring(2, 14);
              savedName = (folder ? folder + '/' : '') + `${stamp}-${cap || 'image'}.${ext}`;
              writeFileSync(join(dir, `${stamp}-${cap || 'image'}.${ext}`), buf);
            } catch {}
          }

          res.setHeader('Content-Type', ct);
          if (savedName) res.setHeader('X-Saved-As', encodeURIComponent(savedName));
          res.end(buf);
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      // 连通性测试（零额度消耗：仅校验代理与 cookie 配置存在）
      server.middlewares.use('/imagifly-proxy/ping', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: !!cookie, hint: cookie ? '' : 'IMAGIFLY_COOKIE 未配置' }));
      });

      // 保存任意图片（dataURL POST 或外站 URL GET?save=1）到 saved-images/
      // 用于自定义生图 API：返回的 b64_json / 外站 URL 无法走 cookie 代理落盘
      server.middlewares.use('/imagifly-proxy/save-data', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString();
          const m = raw.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/s);
          if (!m) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Not a valid image data URL' }));
            return;
          }
          const buf = Buffer.from(m[2], 'base64');
          const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
          const url = new URL(req.url, 'http://localhost');
          const cap = (url.searchParams.get('caption') || '').replace(/[\\/:*?"<>|\s]+/g, '').substring(0, 24);
          const folder = (url.searchParams.get('folder') || '').replace(/[\\/:*?"<>|]+/g, '').substring(0, 50);
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').substring(2, 14);
          const fileName = `${stamp}-${cap || 'image'}.${ext}`;
          const savedName = (folder ? folder + '/' : '') + fileName;
          const dir = resolve(process.cwd(), 'saved-images', ...((folder && folder.length > 0 && folder !== '.') ? [folder] : []));
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, fileName), buf);
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('X-Saved-As', encodeURIComponent(savedName));
          res.end(JSON.stringify({ ok: true, savedName }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      // 打开本地图片文件夹（资源管理器）
      server.middlewares.use('/imagifly-proxy/open-folder', async (req, res) => {
        const u = new URL(req.url, 'http://localhost');
        const folder = (u.searchParams.get('folder') || '').replace(/[\\/:*?"<>|]+/g, '').substring(0, 50);
        const dir = resolve(process.cwd(), 'saved-images', ...((folder && folder.length > 0 && folder !== '.') ? [folder] : []));
        try {
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          if (process.platform === 'win32') {
            spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref();
          } else if (process.platform === 'darwin') {
            spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
          } else {
            spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
          }
          res.statusCode = 200;
          res.end(JSON.stringify({ ok: true, dir }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // loadEnv 会读取项目根目录的 .env / .env.{mode} 文件
  const env = loadEnv(mode, process.cwd(), '');
  const suanliKey = env.VITE_SUANLI_API_KEY || '';
  const imagiflyCookie = env.IMAGIFLY_COOKIE || '';

  const plugins = [llmProxyPlugin()];
  if (imagiflyCookie) {
    plugins.push(imagiflyProxyPlugin(imagiflyCookie));
  }

  return {
    root: 'src',
    server: {
      port: 5173,
      open: true,
      fs: { allow: ['..'] },
    },
    plugins,
    define: {
      'import.meta.env.VITE_SUANLI_API_KEY': JSON.stringify(suanliKey),
      'import.meta.env.VITE_IMAGIFLY_ENABLED': JSON.stringify(imagiflyCookie ? '1' : ''),
    },
    build: {
      outDir: '../dist',
      emptyOutDir: true,
    },
  };
});

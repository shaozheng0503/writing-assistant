import { defineConfig, loadEnv } from 'vite';

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
      // 提交生图请求
      server.middlewares.use('/imagifly-proxy/submit', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks).toString();
          const { prompt, model, size, imageCount } = JSON.parse(body);

          const apiRes = await fetch(`${BASE}/api/images/generate`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Cookie': cookie,
              'Referer': `${BASE}/zh/create`,
              'User-Agent': UA,
              'Accept': 'application/json, */*',
            },
            body: JSON.stringify({
              prompt,
              model: model || 'nano-banana-2',
              size: size || '1368x768',
              imageCount: imageCount || 1,
            }),
          });

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
          let error = null;

          if (apiJson.generation && typeof apiJson.generation === 'object') {
            status = apiJson.generation.status || 'pending';
            if (status === 'success') {
              const assets = apiJson.generation.assets || [];
              if (assets.length > 0) imageUrl = assets[0].url;
            } else if (status === 'failed') {
              error = apiJson.generation.error || apiJson.error || 'failed';
            }
          } else if (typeof apiJson.generation === 'string') {
            status = 'pending'; // generation 字段为字符串说明还在处理
          }

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ status, imageUrl, error }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      // 下载图片（转发 asset URL，注入 cookie）
      server.middlewares.use('/imagifly-proxy/image', async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const target = url.searchParams.get('url');
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
          if (buf[0] === 0xff && buf[1] === 0xd8) ct = 'image/jpeg';
          else if (buf[0] === 0x89 && buf[1] === 0x50) ct = 'image/png';

          res.setHeader('Content-Type', ct);
          res.end(buf);
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

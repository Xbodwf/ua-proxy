import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { parse } from 'node-html-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 7891;
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 全局配置
let proxyConfig = {
    processLinks: true, // 是否处理超链接跳转
};

const server = http.createServer(app);

app.use(express.json()); // 支持解析 JSON 消息体

// WebSocket 代理处理
server.on('upgrade', (req, socket, head) => {
    let fullUrl = req.url.substring(1);
    console.log(`🔌 WS Upgrade Request: ${req.url}`);
    
    if (fullUrl.startsWith('ws://') || fullUrl.startsWith('wss://')) {
        try {
            const targetUrl = new URL(fullUrl);
            console.log(`🔌 WS Target URL: ${targetUrl.href}`);
            const isWss = targetUrl.protocol === 'wss:';
            const port = targetUrl.port || (isWss ? 443 : 80);
            
            // 构造 WS 转发头部
            const headers = { ...req.headers };
            
            // 关键：修复 Origin 和 Referer。WS 校验非常看重这些
            // Bilibili 校验非常严格，Origin 必须是具体的 bilibili 域名
            let realOrigin = 'https://www.bilibili.com';
            if (targetUrl.hostname.includes('chat.bilibili.com')) {
                realOrigin = 'https://live.bilibili.com';
            } else if (targetUrl.hostname.endsWith('.bilibili.com') || targetUrl.hostname.endsWith('.biliapi.net')) {
                // 尝试从 targetUrl 提取 host 并转换为 https 协议作为 Origin
                realOrigin = `https://${targetUrl.hostname}`;
            }
            headers['origin'] = realOrigin;
            
            // 优化：WS 的 Referer 通常是触发连接的页面 URL
            if (req.headers.referer) {
                const refererMatch = req.headers.referer.match(new RegExp(`${req.headers.host}/(https?://.*)`));
                if (refererMatch) {
                    headers['referer'] = refererMatch[1];
                } else {
                    headers['referer'] = realOrigin + '/';
                }
            } else {
                headers['referer'] = realOrigin + '/';
            }

            headers['host'] = targetUrl.host;
            headers['user-agent'] = DESKTOP_UA;
            headers['connection'] = 'Upgrade';
            headers['upgrade'] = 'websocket';
            
            // 关键：不要手动转发 sec-websocket-key，让 http.request 自动生成
            // 否则会导致握手校验失败
            const sensitiveHeaders = ['sec-websocket-key', 'sec-websocket-extensions', 'sec-websocket-accept'];
            sensitiveHeaders.forEach(h => delete headers[h]);
            
            console.log(`🔌 WS Proxy: ${targetUrl.href} | Origin: ${headers['origin']}`);
            
            // 强制要求不验证 SSL 证书
            const proxyReq = (isWss ? https : http).request({
                hostname: targetUrl.hostname,
                port: port,
                path: targetUrl.pathname + targetUrl.search,
                method: 'GET',
                headers: headers,
                rejectUnauthorized: false,
                timeout: 30000 // 进一步增加超时到 30s
            });

                proxyReq.on('timeout', () => {
                    console.error('🔌 WS Proxy Timeout');
                    proxyReq.destroy();
                    socket.destroy();
                });

            proxyReq.on('response', (proxyRes) => {
                if (proxyRes.statusCode !== 101) {
                    console.error(`🔌 WS Upgrade Rejected: ${proxyRes.statusCode}`);
                    socket.write(`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n\r\n`);
                    socket.destroy();
                }
            });

            proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
                let responseHeaders = `HTTP/1.1 101 Switching Protocols\r\n`;
                Object.keys(proxyRes.headers).forEach(h => {
                    responseHeaders += `${h}: ${proxyRes.headers[h]}\r\n`;
                });
                responseHeaders += '\r\n';
                
                socket.write(responseHeaders);

                // 转发初始数据包 (如果有)
                if (proxyHead && proxyHead.length > 0) {
                    socket.write(proxyHead);
                }

                // 双向管道
                proxySocket.pipe(socket);
                socket.pipe(proxySocket);

                proxySocket.on('error', (err) => {
                    console.error('🔌 Proxy Socket Error:', err.message);
                    socket.destroy();
                });
                socket.on('error', (err) => {
                    console.error('🔌 Local Socket Error:', err.message);
                    proxySocket.destroy();
                });
            });

            proxyReq.on('error', (err) => {
                console.error('🔌 WS Proxy Request Error:', err.message);
                socket.destroy();
            });

            proxyReq.end();
        } catch (e) {
            console.error('🔌 WS URL Parse Error:', e.message);
            socket.destroy();
        }
    } else {
        socket.destroy();
    }
});

// 读取 preload 脚本内容
const PRELOAD_JS = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');

// 客户端 Hook 注入函数
const INJECT_HOOK = (proxyBase) => `
<script>window.__PROXY_CONFIG__ = { proxyBase: "${proxyBase}", config: ${JSON.stringify(proxyConfig)} };</script>
<script src="/__proxy_preload.js"></script>
`;

// 辅助函数：将页面中的 URL 转换为代理 URL
const rewriteUrls = (html, targetUrl, proxyBase) => {
    const root = parse(html);
    
    const transform = (val) => {
        if (!val) return val;
        // 处理协议相对路径 //example.com
        if (val.startsWith('//')) val = 'https:' + val;
        if (val.startsWith('data:') || val.startsWith('#') || val.startsWith('javascript:') || val.startsWith('blob:')) return val;

        try {
            const absoluteUrl = new URL(val, targetUrl).href;
            if (absoluteUrl.startsWith(proxyBase)) return absoluteUrl;
            return `${proxyBase}/${absoluteUrl}`;
        } catch (e) {
            return val;
        }
    };

    // 需要重写的属性列表
    const attrMap = {
        'a': ['href'],
        'img': ['src', 'data-src', 'srcset'],
        'script': ['src', 'data-src'],
        'link': ['href'],
        'iframe': ['src'],
        'source': ['src', 'srcset'],
        'video': ['src', 'poster'],
        'audio': ['src'],
        'form': ['action'],
        'meta': ['content'] // 用于处理 http-equiv="refresh"
    };

    Object.entries(attrMap).forEach(([tag, attrs]) => {
        root.querySelectorAll(tag).forEach(el => {
            attrs.forEach(attr => {
                const val = el.getAttribute(attr);
                if (val) {
                    if (tag === 'meta' && el.getAttribute('http-equiv')?.toLowerCase() === 'refresh') {
                        // 处理 content="5; url=https://example.com"
                        const parts = val.split(/;(?:\s*url=)/i);
                        if (parts.length === 2) {
                            el.setAttribute(attr, `${parts[0]}; url=${transform(parts[1])}`);
                        }
                    } else if (tag === 'meta' && el.getAttribute('name')?.toLowerCase() === 'referrer') {
                        // 强制替换为 no-referrer
                        el.setAttribute(attr, 'no-referrer');
                    } else if (tag === 'meta' && (el.getAttribute('property')?.startsWith('og:') || el.getAttribute('name')?.startsWith('twitter:'))) {
                        // 处理社交媒体分享 URL
                        el.setAttribute(attr, transform(val));
                    } else if (tag === 'meta') {
                        // 其他 meta 标签不随意重写，避免破坏 key-value 逻辑
                        return;
                    } else if (attr === 'srcset') {
                        // srcset 格式特殊：url1 1x, url2 2x
                        const newSrcset = val.split(',').map(part => {
                            const [u, s] = part.trim().split(/\s+/);
                            return s ? `${transform(u)} ${s}` : transform(u);
                        }).join(', ');
                        el.setAttribute(attr, newSrcset);
                    } else {
                        el.setAttribute(attr, transform(val));
                    }
                }
            });
        });
    });

    // 注入 Hook 脚本和强制 Referrer 策略
    const head = root.querySelector('head');
    const metaReferrer = `<meta name="referrer" content="no-referrer">`;
    const injectScripts = INJECT_HOOK(proxyBase);
    
    if (head) {
        // 寻找第一个 script 标签，在其之前注入，这样可以尽量早地执行 Hook，同时不破坏某些脚本对 head 子节点顺序的依赖
        const firstScript = head.querySelector('script');
        if (firstScript) {
            firstScript.insertAdjacentHTML('beforebegin', metaReferrer + injectScripts);
        } else {
            head.insertAdjacentHTML('afterbegin', metaReferrer + injectScripts);
        }
    } else {
        // 如果没有 head，注入到 body 开头
        const body = root.querySelector('body');
        if (body) {
            body.insertAdjacentHTML('afterbegin', metaReferrer + injectScripts);
        }
    }

    return root.toString();
};

app.get('/__proxy_preload.js', (req, res) => {
    res.header('Content-Type', 'application/javascript');
    res.send(PRELOAD_JS);
});

// 更新配置的接口
app.post('/__proxy_api/config', (req, res) => {
    const { processLinks } = req.body;
    if (typeof processLinks === 'boolean') {
        proxyConfig.processLinks = processLinks;
        console.log('⚙️ 配置已更新:', proxyConfig);
        return res.json({ success: true, config: proxyConfig });
    }
    res.status(400).json({ success: false, message: '无效的配置项' });
});

app.use(async (req, res) => {
    // 处理 OPTIONS 请求
    if (req.method === 'OPTIONS') {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
        res.header('Access-Control-Allow-Headers', '*');
        return res.sendStatus(200);
    }

    let fullUrl = req.url.substring(1);
    const proxyBase = `http://${req.headers.host}`;
    
    // 如果 fullUrl 不以 http 开头，尝试通过 Referer 恢复真实的 targetUrl
    // 这种情况通常发生在客户端 JS 发送了相对路径请求，且 Hook 未能完全覆盖时
    if (fullUrl && !fullUrl.startsWith('http')) {
        const referer = req.headers.referer;
        if (referer && referer.includes(proxyBase)) {
            try {
                // 从 Referer 中提取原始目标基准 URL
                // 例如 Referer: http://localhost:7891/https://www.bilibili.com/
                const refererMatch = referer.match(new RegExp(`${proxyBase}/(https?://[^/]+/?.*)`));
                if (refererMatch) {
                    const refererTarget = refererMatch[1];
                    const recoveredUrl = new URL(fullUrl, refererTarget).href;
                    // console.log(`🔄 恢复相对路径: ${fullUrl} -> ${recoveredUrl}`);
                    fullUrl = recoveredUrl;
                }
            } catch (e) {
                // 恢复失败，继续原有逻辑
            }
        }
    }
    
    if (!fullUrl || !fullUrl.startsWith('http')) {
        return res.status(200).send(`
            <html>
                <head>
                    <title>UA Proxy 控制面板</title>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; background: #f4f7f9; }
                        .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); margin-bottom: 2rem; }
                        h1 { margin-top: 0; color: #007aff; }
                        code { background: #eee; padding: 0.2rem 0.4rem; border-radius: 4px; font-family: monospace; }
                        .config-item { display: flex; align-items: center; justify-content: space-between; padding: 1rem 0; border-bottom: 1px solid #eee; }
                        .config-item:last-child { border-bottom: none; }
                        .switch { position: relative; display: inline-block; width: 50px; height: 26px; }
                        .switch input { opacity: 0; width: 0; height: 0; }
                        .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 34px; }
                        .slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 4px; bottom: 4px; background-color: white; transition: .4s; border-radius: 50%; }
                        input:checked + .slider { background-color: #007aff; }
                        input:checked + .slider:before { transform: translateX(24px); }
                        .btn { background: #007aff; color: white; border: none; padding: 0.8rem 1.5rem; border-radius: 8px; cursor: pointer; font-size: 1rem; transition: background 0.3s; }
                        .btn:hover { background: #0056b3; }
                        .input-group { margin-top: 1rem; }
                        input[type="text"] { width: 100%; padding: 0.8rem; border: 1px solid #ddd; border-radius: 8px; margin-top: 0.5rem; box-sizing: border-box; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>UA Proxy 控制面板</h1>
                        <p>当前运行状态：<span style="color: #34c759;">● 正常</span></p>
                        <p>当前 Desktop UA: <code>${DESKTOP_UA}</code></p>
                    </div>

                    <div class="card">
                        <h3>代理设置</h3>
                        <div class="config-item">
                            <div>
                                <strong>处理超链接跳转</strong>
                                <div style="font-size: 0.85rem; color: #666;">启用后，点击页面内的链接将自动通过代理打开</div>
                            </div>
                            <label class="switch">
                                <input type="checkbox" id="processLinks" ${proxyConfig.processLinks ? 'checked' : ''} onchange="updateConfig()">
                                <span class="slider"></span>
                            </label>
                        </div>
                    </div>

                    <div class="card">
                        <h3>快速访问</h3>
                        <div class="input-group">
                            <input type="text" id="targetUrl" placeholder="输入目标 URL (例如: https://www.bilibili.com)" onkeypress="if(event.key==='Enter') goToProxy()">
                            <button class="btn" style="margin-top: 1rem; width: 100%;" onclick="goToProxy()">立即进入代理</button>
                        </div>
                    </div>

                    <script>
                        async function updateConfig() {
                            const processLinks = document.getElementById('processLinks').checked;
                            try {
                                const res = await fetch('/__proxy_api/config', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ processLinks })
                                });
                                const data = await res.json();
                                if (data.success) {
                                    console.log('配置更新成功');
                                }
                            } catch (e) {
                                alert('配置更新失败: ' + e.message);
                            }
                        }

                        function goToProxy() {
                            const url = document.getElementById('targetUrl').value.trim();
                            if (!url) return alert('请输入有效的 URL');
                            const target = url.startsWith('http') ? url : 'https://' + url;
                            window.location.href = '/' + target;
                        }
                    </script>
                </body>
            </html>
        `);
    }

    try {
        const targetUrl = new URL(fullUrl).href;
        const proxyBase = `http://${req.headers.host}`;

        // 构造转发给目标服务器的头部
        const forwardHeaders = { ...req.headers };
        
        // 1. 强制使用桌面版 UA
        forwardHeaders['user-agent'] = DESKTOP_UA;
        
        // 2. 修复 Referer: 从代理地址还原为真实地址
        if (req.headers.referer) {
            const refererMatch = req.headers.referer.match(new RegExp(`${proxyBase}/(https?://.*)`));
            if (refererMatch) {
                forwardHeaders['referer'] = refererMatch[1];
            } else {
                forwardHeaders['referer'] = new URL(targetUrl).origin + '/';
            }
        } else {
            forwardHeaders['referer'] = new URL(targetUrl).origin + '/';
        }

        // 优化：针对 Bilibili 资源域名的特殊 Referer 处理
        const targetHost = new URL(targetUrl).hostname;
        if (targetHost.endsWith('.hdslb.com') || targetHost.endsWith('.akamaized.net')) {
            forwardHeaders['referer'] = 'https://www.bilibili.com/';
        }

        // 3. 修复 Origin
        if (req.headers.origin) {
            if (req.headers.origin.includes(req.headers.host)) {
                const targetOrigin = new URL(targetUrl).origin;
                forwardHeaders['origin'] = targetOrigin;
                
                if (forwardHeaders['referer']) {
                    try {
                        const refererOrigin = new URL(forwardHeaders['referer']).origin;
                        if (refererOrigin.endsWith('.bilibili.com') || refererOrigin.endsWith('.biliapi.net')) {
                            forwardHeaders['origin'] = refererOrigin;
                        }
                    } catch(e) {}
                }
            }
        }

        // 4. 修复 Sec-Fetch-* 头部，避免被识别为跨站请求
        if (forwardHeaders['sec-fetch-site'] === 'cross-site') {
            forwardHeaders['sec-fetch-site'] = 'same-site';
        }
        if (forwardHeaders['sec-fetch-mode'] === 'cors') {
            // 保持 cors，但确保 origin 正确
        }

        // 移除导致问题的头部
        delete forwardHeaders['host'];
        delete forwardHeaders['connection'];
        delete forwardHeaders['content-length']; // fetch 会自动计算
        
        // 增加对 bilibili 的特殊支持：保持一些可能被检查的头部
        // 比如 sec-ch-ua 系列
        Object.keys(forwardHeaders).forEach(key => {
            if (key.startsWith('sec-ch-ua')) {
                // 保持这些头部以减少被识别为爬虫的概率
            }
        });

        const response = await fetch(targetUrl, {
            method: req.method,
            body: ['GET', 'HEAD'].includes(req.method) ? null : req,
            headers: forwardHeaders,
            redirect: 'manual', 
            duplex: 'half'
        });

        // 处理重定向 (301, 302, 307, 308)
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (location) {
                const absoluteLocation = new URL(location, targetUrl).href;
                res.status(response.status).header('Location', `${proxyBase}/${absoluteLocation}`).send();
                return;
            }
        }

        const contentType = response.headers.get('content-type') || '';
        
        // 复制原始响应的部分关键头部
        const headersToCopy = ['content-type', 'cache-control', 'expires'];
        headersToCopy.forEach(h => {
            const val = response.headers.get(h);
            if (val) res.header(h, val);
        });

        // 允许跨域并移除安全限制
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
        res.header('Access-Control-Allow-Headers', '*');
        res.header('Access-Control-Allow-Credentials', 'true');

        // 移除 CSP 头部，防止拦截我们的 Hook 脚本
        res.removeHeader('Content-Security-Policy');
        res.removeHeader('X-Content-Security-Policy');
        res.removeHeader('X-WebKit-CSP');
        // 移除 X-Frame-Options 以允许在 iframe 中加载
        res.removeHeader('X-Frame-Options');

        // 处理 set-cookie: 移除 Domain 限制，让浏览器接受来自代理的 Cookie
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) {
            // 移除 Domain 和 Secure 标记，确保在非 HTTPS 的 localhost 下也能存储
            const proxiedCookie = setCookie
                .replace(/Domain=[^;]+;?/gi, '')
                .replace(/Secure;?/gi, '');
            res.header('set-cookie', proxiedCookie);
        }

        if (contentType.includes('text/html')) {
            let body = await response.text();
            body = rewriteUrls(body, targetUrl, proxyBase);
            res.header('Content-Type', 'text/html; charset=utf-8');
            return res.send(body);
        } else if (contentType.includes('text/css')) {
            let body = await response.text();
            // 改进的 CSS URL 重写: 支持空格、引号和多种属性
            body = body.replace(/url\s*\(\s*['"]?(.*?)['"]?\s*\)/g, (match, url) => {
                const trimmedUrl = url.trim();
                // 排除 data:, blob:, # 等不需要代理的协议
                if (!trimmedUrl || /^(data:|blob:|#|javascript:)/i.test(trimmedUrl)) return match;
                
                if (trimmedUrl.startsWith('http') || trimmedUrl.startsWith('//')) {
                    try {
                        const absoluteUrl = new URL(trimmedUrl.startsWith('//') ? 'https:' + trimmedUrl : trimmedUrl, targetUrl).href;
                        return `url("${proxyBase}/${absoluteUrl}")`;
                    } catch (e) {
                        return match;
                    }
                }
                // 处理相对路径
                try {
                    const absoluteUrl = new URL(trimmedUrl, targetUrl).href;
                    return `url("${proxyBase}/${absoluteUrl}")`;
                } catch (e) {
                    return match;
                }
            });
            res.header('Content-Type', 'text/css; charset=utf-8');
            return res.send(body);
        } else if (contentType.includes('application/javascript') || contentType.includes('text/javascript')) {
            let body = await response.text();
            
            // 完全禁用 JS 内容重写，避免破坏语法
            // 所有的 URL 拦截都交给 preload.js 中的运行时 Hook 处理

            res.header('Content-Type', contentType);
            return res.send(body);
        } else {
            // 对于非文本资源（图片、视频等），直接转发流
            res.header('Content-Type', contentType);
            // 使用管道转发以提高性能并处理大文件
            // 注意：fetch 的 response.body 是一个 ReadableStream，需要转换为 Node.js Readable
            const { Readable } = await import('stream');
            return Readable.fromWeb(response.body).pipe(res);
        }
    } catch (err) {
        console.error('Proxy Error:', err);
        return res.status(500).send('Proxy Error: ' + err.message);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 高级重写代理已启动: http://localhost:${PORT}/https://www.bilibili.com`);
});

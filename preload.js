(function() {
    // 抹除自动化检测痕迹
    try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // 伪装成桌面环境的其他属性
        if (navigator.userAgentData) {
            const mockData = {
                brands: [
                    { brand: 'Not_A Brand', version: '8' },
                    { brand: 'Chromium', version: '120' },
                    { brand: 'Google Chrome', version: '120' }
                ],
                mobile: false,
                platform: 'Windows'
            };
            Object.defineProperty(navigator, 'userAgentData', {
                get: () => ({
                    ...mockData,
                    getHighEntropyValues: (hints) => Promise.resolve({
                        ...mockData,
                        architecture: 'x86',
                        bitness: '64',
                        model: '',
                        platformVersion: '10.0.0',
                        uaFullVersion: '120.0.0.0'
                    })
                })
            });
        }
    } catch(e) {}

    // 修复：针对 passport.bilibili.com 等可能逃逸的情况，增加更激进的拦截
    const AGGRESSIVE_INTERCEPT_DOMAINS = [
        'passport.bilibili.com',
        'account.bilibili.com',
        'api.bilibili.com',
        'data.bilibili.com',
        'hdslb.com',
        'biliapi.net'
    ];

    // 从当前 script 标签获取配置，或者通过全局变量
    const PROXY_BASE = window.__PROXY_CONFIG__?.proxyBase || (window.location.origin);
    const PROCESS_LINKS = window.__PROXY_CONFIG__?.config?.processLinks !== false;
    
    window.__PROXY_URL__ = function(url) {
        if (!url || typeof url !== 'string') return url;
        
        // 清洗 URL，移除首尾空格
        url = url.trim();
        
        // 排除不需要代理的协议
        if (/^(data:|blob:|javascript:|#)/i.test(url)) return url;
        
        // 如果已经是代理 URL，直接返回 (增加对端口不一致的容错)
        if (url.includes('/http://') || url.includes('/https://') || url.includes('/ws://') || url.includes('/wss://')) {
            if (url.startsWith(window.location.origin) || url.startsWith(PROXY_BASE)) {
                return url;
            }
        }
        
        try {
            // 获取当前页面的真实目标 URL（从代理 URL 中提取）
            let base = window.location.pathname;
            if (base.startsWith('/')) base = base.substring(1);
            
            // 改进：更可靠地提取基准 URL
            const proxyMatch = window.location.href.match(/https?:\/\/[^\/]+\/((?:https?|wss?):\/\/.*)/);
            if (proxyMatch) {
                base = proxyMatch[1];
            } else if (!base.startsWith('http')) {
                base = window.location.origin;
            }

            let targetUrl = url;
            // 处理协议相对路径 //example.com
            if (url.startsWith('//')) {
                const protocol = base.startsWith('wss') ? 'wss:' : (base.startsWith('ws') ? 'ws:' : 'https:');
                targetUrl = protocol + url;
            }
            
            // 强制拦截列表中的域名
            const isAggressiveDomain = AGGRESSIVE_INTERCEPT_DOMAINS.some(domain => targetUrl.includes(domain));
            
            // 如果已经是绝对路径且不是代理路径，直接使用
            if (/^(https?|wss?):\/\//i.test(targetUrl)) {
                if (targetUrl.startsWith(PROXY_BASE) || targetUrl.startsWith(window.location.origin)) {
                    return targetUrl;
                }
                return PROXY_BASE + '/' + targetUrl;
            }

            // 使用 URL 类合成绝对地址
            const absoluteUrl = new URL(targetUrl, base).href;
            
            if (absoluteUrl.startsWith(PROXY_BASE) || absoluteUrl.startsWith(window.location.origin)) {
                return absoluteUrl;
            }
            
            return PROXY_BASE + '/' + absoluteUrl;
        } catch (e) {
            // 兜底：如果解析失败且包含激进拦截域名，强制拼接
            if (typeof url === 'string' && AGGRESSIVE_INTERCEPT_DOMAINS.some(domain => url.includes(domain))) {
                if (!url.startsWith('http') && !url.startsWith('/')) {
                    return PROXY_BASE + '/https://' + url;
                }
            }
            return url;
        }
    };

    const proxyUrl = window.__PROXY_URL__;
    const originalFetch = window.fetch;
    const originalOpen = window.open;
    const originalSetAttribute = Element.prototype.setAttribute;

    // 1. Hook fetch
    Object.defineProperty(window, 'fetch', {
        value: function(input, init) {
            if (typeof input === 'string') {
                input = proxyUrl(input);
            } else if (input && input.url) {
                const newUrl = proxyUrl(input.url);
                input = new Request(newUrl, input);
            }
            return originalFetch.call(this, input, init);
        },
        configurable: true, writable: true
    });

    // 2. Hook XMLHttpRequest
    const originalXHR = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function(method, url, ...args) {
        return originalXHR.apply(this, [method, proxyUrl(url), ...args]);
    };

    // 3. Hook property setters
    const elementsToHook = [
        { proto: HTMLImageElement.prototype, props: ['src', 'srcset'] },
        { proto: HTMLScriptElement.prototype, props: ['src'] },
        { proto: HTMLLinkElement.prototype, props: ['href'] },
        { proto: HTMLAnchorElement.prototype, props: ['href'] },
        { proto: HTMLIFrameElement.prototype, props: ['src'] },
        { proto: HTMLSourceElement.prototype, props: ['src', 'srcset'] },
        { proto: HTMLVideoElement.prototype, props: ['src', 'poster'] },
        { proto: HTMLAudioElement.prototype, props: ['src'] },
        { proto: HTMLFormElement.prototype, props: ['action'] }
    ];

    elementsToHook.forEach(({ proto, props }) => {
        props.forEach(prop => {
            const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
            if (descriptor && descriptor.set) {
                const originalSet = descriptor.set;
                Object.defineProperty(proto, prop, {
                    set: function(val) {
                        return originalSet.call(this, proxyUrl(val));
                    }
                });
            }
        });
    });

    // 4. Hook window.open
    window.open = function(url, ...args) {
        const proxiedUrl = proxyUrl(url);
        const win = originalOpen.apply(this, [proxiedUrl, ...args]);
        if (win) {
            try {
                // 在新窗口中注入基础配置，使其也能使用代理逻辑
                const script = win.document.createElement('script');
                script.textContent = `window.__PROXY_CONFIG__ = { proxyBase: "${PROXY_BASE}" };`;
                win.document.head.appendChild(script);
                
                const loader = win.document.createElement('script');
                loader.src = "/__proxy_preload.js";
                win.document.head.appendChild(loader);
            } catch(e) {}
        }
        return win;
    };

    // 5. Hook Worker
    if (window.Worker) {
        const OriginalWorker = window.Worker;
        window.Worker = function(scriptURL, options) {
            const proxiedURL = proxyUrl(scriptURL);
            // 对于同源的 Worker，尝试注入注入配置
            const worker = new OriginalWorker(proxiedURL, options);
            return worker;
        };
    }

    // 6. Hook Navigator 相关 API
    if (navigator.sendBeacon) {
        const originalSendBeacon = navigator.sendBeacon;
        navigator.sendBeacon = function(url, data) {
            return originalSendBeacon.call(this, proxyUrl(url), data);
        };
    }

    if (navigator.serviceWorker) {
        const originalRegister = navigator.serviceWorker.register;
        navigator.serviceWorker.register = function(scriptURL, options) {
            console.log('🛠️ ServiceWorker register intercepted:', scriptURL);
            return originalRegister.call(this, proxyUrl(scriptURL), options);
        };
    }

    // Hook navigator.registerProtocolHandler
    if (navigator.registerProtocolHandler) {
        const originalRegisterProtocolHandler = navigator.registerProtocolHandler;
        navigator.registerProtocolHandler = function(scheme, url, title) {
            return originalRegisterProtocolHandler.call(this, scheme, proxyUrl(url), title);
        };
    }

    // 7. Hook EventSource (SSE)
    if (window.EventSource) {
        const OriginalEventSource = window.EventSource;
        window.EventSource = function(url, config) {
            return new OriginalEventSource(proxyUrl(url), config);
        };
    }

    // 8. Hook location API
    try {
        const locProto = Location.prototype;
        
        // 拦截 replace 和 assign
        const originalReplace = locProto.replace;
        locProto.replace = function(url) { 
            return originalReplace.call(this, proxyUrl(url)); 
        };
        const originalAssign = locProto.assign;
        locProto.assign = function(url) { 
            return originalAssign.call(this, proxyUrl(url)); 
        };
        
        // 拦截 href setter
        const hrefDesc = Object.getOwnPropertyDescriptor(locProto, 'href');
        if (hrefDesc && hrefDesc.set) {
            Object.defineProperty(locProto, 'href', {
                set: function(val) {
                    return hrefDesc.set.call(this, proxyUrl(val));
                }
            });
        }

        // 增强：拦截 window.location 直接赋值
        // 虽然不能直接重写 window.location，但可以尝试在 window 上定义
        // 注意：这在某些浏览器中可能会失败或导致无限递归，需谨慎
        try {
            const originalLocation = window.location;
            // 某些情况下可以通过这种方式拦截赋值，但 Location 对象通常是不可配置的
            // 这里的策略是主要依靠 href setter 和 method hooks
        } catch(e) {}

        // 拦截 window.navigate (IE 遗留，但有些库还在用)
        if (window.navigate) {
            const originalNavigate = window.navigate;
            window.navigate = function(url) {
                return originalNavigate.call(this, proxyUrl(url));
            };
        }

        // 防止通过修改 hostname, protocol, port 等方式逃逸
        // 只要修改 these 属性，一律重定向回代理包装后的 URL
        ['hostname', 'protocol', 'port', 'host'].forEach(prop => {
            const desc = Object.getOwnPropertyDescriptor(locProto, prop);
            if (desc && desc.set) {
                Object.defineProperty(locProto, prop, {
                    set: function(val) {
                        // 获取当前已经代理的真实目标 URL，修改相应部分后再重新包装
                        try {
                            const currentTarget = new URL(window.location.pathname.substring(1) || window.location.href.match(/https?:\/\/[^\/]+\/(https?:\/\/.*)/)[1]);
                            currentTarget[prop] = val;
                            window.location.href = proxyUrl(currentTarget.href);
                        } catch(e) {
                            // 降级处理
                        }
                    }
                });
            }
        });
    } catch(e) {
        console.error('Location hook error:', e);
    }
    
    // 7. Hook History API
    try {
        const originalPushState = History.prototype.pushState;
        History.prototype.pushState = function(state, title, url) {
            return originalPushState.apply(this, [state, title, url ? proxyUrl(url) : url]);
        };
        const originalReplaceState = History.prototype.replaceState;
        History.prototype.replaceState = function(state, title, url) {
            return originalReplaceState.apply(this, [state, title, url ? proxyUrl(url) : url]);
        };
    } catch(e) {}

    // 8. Hook setAttribute
    Element.prototype.setAttribute = function(name, value) {
        if (typeof value === 'string') {
            const lowerName = name.toLowerCase();
            // 仅拦截确认为 URL 的属性
            const urlAttrs = ['src', 'href', 'srcset', 'data-src', 'data-url', 'data-original', 'data-thumbnail', 'action'];
            if (urlAttrs.includes(lowerName)) {
                value = proxyUrl(value);
            }
        }
        return originalSetAttribute.apply(this, [name, value]);
    };

    // 9. 拦截点击事件
    document.addEventListener('click', function(e) {
        if (!PROCESS_LINKS) return; // 根据配置决定是否处理链接
        
        let target = e.target;
        while (target && target.tagName !== 'A') target = target.parentElement;
        if (target && target.href) {
            const attrHref = target.getAttribute('href');
            if (attrHref && !attrHref.startsWith(PROXY_BASE) && !attrHref.startsWith('#') && !attrHref.startsWith('javascript:')) {
                target.href = proxyUrl(attrHref);
            }
        }
    }, true);

    // 10. 监听 DOM 变化，处理动态插入的 meta refresh
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.tagName === 'META' && node.getAttribute('http-equiv')?.toLowerCase() === 'refresh') {
                    const content = node.getAttribute('content');
                    if (content) {
                            const parts = content.split(/;(?:\s*url=)/i);
                            if (parts.length === 2) {
                                node.setAttribute('content', `${parts[0]}; url=${proxyUrl(parts[1])}`);
                            }
                        }
                }
            });
        });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // 11. 移除不稳定的构造函数拦截，改为依赖原型链 Hook
    // 之前这里的 hookConstructor 导致了 Bilibili 播放器脚本出现 TypeError: style 错误
    
    // 12. Hook CSS background-image via setProperty
    const originalSetProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function(prop, value, priority) {
        try {
            if ((prop === 'background-image' || prop === 'background' || prop === 'border-image' || prop === 'list-style-image' || prop === 'content') && typeof value === 'string' && value.includes('url(')) {
                // 改进正则：支持空格和多种引号
                value = value.replace(/url\s*\(\s*['"]?(.*?)['"]?\s*\)/g, (match, url) => {
                    return `url("${proxyUrl(url.trim())}")`;
                });
            }
            return originalSetProperty.apply(this, [prop, value, priority]);
        } catch (e) {
            // 鲁棒性：如果 setProperty 报错，尝试回退到原始方法
            return originalSetProperty.apply(this, arguments);
        }
    };

    // 13. Hook URL.createObjectURL (处理 Blob 资源)
    if (window.URL && window.URL.createObjectURL) {
        const originalCreateObjectURL = window.URL.createObjectURL;
        window.URL.createObjectURL = function(obj) {
            const url = originalCreateObjectURL.call(URL, obj);
            // Blob URL 不需要通过服务器代理，但在某些严格环境下可能需要处理
            // 暂时保持原样，仅记录
            return url;
        };
    }

    // 11. Hook WebSocket
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
        let targetUrl = url;
        if (typeof url === 'string') {
            // 针对 Socket.io 等可能带有协议前缀的 URL 进行处理
            const proxied = proxyUrl(url);
            
            if (proxied.startsWith('http://') || proxied.startsWith('https://')) {
                // 强制将代理后的 URL 转换为 ws/wss 协议
                if (proxied.includes(window.location.host) || proxied.includes(PROXY_BASE.replace(/^https?:\/\//, ''))) {
                    targetUrl = proxied.replace(/^https?/, 'ws');
                } else {
                    targetUrl = proxied.replace(/^http/, 'ws');
                }
            }
        }
        
        console.log('🔌 WebSocket Proxy:', url, '->', targetUrl);
        try {
            return protocols ? new OriginalWebSocket(targetUrl, protocols) : new OriginalWebSocket(targetUrl);
        } catch (e) {
            console.error('🔌 WebSocket Connection Error:', e);
            // 降级：尝试原始 URL
            return protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
        }
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    window.WebSocket.OPEN = OriginalWebSocket.OPEN;
    window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
    window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

    // 12. Hook postMessage (修复跨域 Origin 检查)
    const originalPostMessage = window.postMessage;
    window.postMessage = function(message, targetOrigin, transfer) {
        // 修复：处理 targetOrigin 为 undefined, null 或 "undefined" 的情况
        if (targetOrigin === undefined || targetOrigin === null || targetOrigin === 'undefined') {
            targetOrigin = '*';
        }
        // 如果 targetOrigin 是具体的域名，且不是当前代理域名，则尝试放宽限制
        if (typeof targetOrigin === 'string' && targetOrigin !== '*' && !targetOrigin.startsWith(window.location.origin)) {
            // 如果是 bilibili 相关的 Origin，尝试放宽
            if (targetOrigin.includes('bilibili.com') || targetOrigin.includes('biliapi.net') || targetOrigin.includes('hdslb.com')) {
                targetOrigin = '*';
            }
        }
        try {
            return originalPostMessage.apply(this, [message, targetOrigin, transfer]);
        } catch (e) {
            // 兜底：如果报错，尝试用 * 再次发送
            return originalPostMessage.apply(this, [message, '*', transfer]);
        }
    };

    console.log('UA Proxy Preload Hook Loaded');
})();
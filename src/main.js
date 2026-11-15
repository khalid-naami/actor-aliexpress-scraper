import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { chromium } from 'playwright';
import {
    detectAliExpressPageState,
    extractAliExpressItemId,
    parseAliExpressProductHtml,
    parseAliExpressSearchHtml,
} from './extractors.js';

function sanitizeRecord(obj) {
    if (Array.isArray(obj)) return obj.map((item) => sanitizeRecord(item));
    if (!obj || typeof obj !== 'object') return obj;
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== null && v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))) {
            clean[k] = Array.isArray(v)
                ? v.map((item) => (item && typeof item === 'object' ? sanitizeRecord(item) : item))
                : v && typeof v === 'object' && !(v instanceof Date)
                    ? sanitizeRecord(v)
                    : v;
        }
    }
    return clean;
}

function isProxyTransportError(errOrStatus) {
    if (errOrStatus === 597 || errOrStatus === 407 || errOrStatus === 502) return true;
    const msg = String(errOrStatus?.message || errOrStatus || '');
    return /597|UPSTREAM407|407|502|Proxy responded with|tunneling socket|ERR_TUNNEL|ERR_PROXY|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up/i.test(msg);
}

await Actor.init();

let browser = null;
const closeBrowser = async () => {
    if (!browser) return;
    const instance = browser;
    browser = null;
    try {
        await instance.close();
    } catch {
        // Ignore close errors during rotation or shutdown
    }
};

Actor.on('aborting', async () => {
    await closeBrowser();
});

try {
    const input = (await Actor.getInput()) || {};
    const {
        productUrls = [],
        searchKeywords = [],
        sortBy = 'orders',
        shipToCountry = 'US',
        maxProducts = 40,
        proxyConfiguration,
    } = input;

    const cleanCountry = String(shipToCountry || 'US').toUpperCase();
    log.info(`Starting AliExpress Dropshipping Scraper (Ship to: ${cleanCountry}, Sort: ${sortBy})...`);

    let proxyConfig = null;
    let proxyUrl = undefined;
    let proxyFailureCount = 0;
    if (proxyConfiguration) {
        try {
            proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
            if (proxyConfig) {
                proxyUrl = await proxyConfig.newUrl();
                log.info('Proxy enabled successfully');
            }
        } catch (proxyErr) {
            log.warning(`Proxy initialization failed (${proxyErr.message}); continuing with direct connection.`);
        }
    }

    const rotateOrDisableProxy = async (errOrStatus) => {
        if (!proxyUrl || !isProxyTransportError(errOrStatus)) return false;
        proxyFailureCount++;
        await closeBrowser();
        if (proxyConfig && proxyFailureCount <= 1) {
            try {
                proxyUrl = await proxyConfig.newUrl();
                log.warning('Rotated Apify Proxy session after upstream proxy transport error.');
                return true;
            } catch {
                // Fall through to disable proxy
            }
        }
        proxyUrl = undefined;
        log.warning('Disabled broken proxy session after transport failures; falling back to direct connection.');
        return true;
    };

    const getBrowser = async () => {
        if (!browser) {
            const launchOptions = {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                ],
            };
            if (proxyUrl) {
                try {
                    const u = new URL(proxyUrl);
                    launchOptions.proxy = {
                        server: `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`,
                        ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
                        ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
                    };
                } catch {
                    launchOptions.proxy = { server: proxyUrl };
                }
            }
            browser = await chromium.launch(launchOptions);
        }
        return browser;
    };

    const headers = {
        'accept-language': 'en-US,en;q=0.9',
        'cookie': `aep_usuc_f=site=glo&c_tp=USD&region=${cleanCountry}&b_locale=en_US;`,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    };

    const fetchHtmlWithHttp = async (url) => {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const response = await gotScraping({
                    url,
                    proxyUrl,
                    headers,
                    timeout: { request: 25000 },
                    throwHttpErrors: false,
                });
                if (isProxyTransportError(response.statusCode)) {
                    const handled = await rotateOrDisableProxy(response.statusCode);
                    if (handled) continue;
                }
                const html = response.body || '';
                const pageState = detectAliExpressPageState(html, response.statusCode);
                return { html, statusCode: response.statusCode, pageState };
            } catch (err) {
                const handled = await rotateOrDisableProxy(err);
                log.debug(`gotScraping attempt ${attempt + 1} failed for ${url}: ${err.message}`);
                if (!handled || attempt === 1) break;
            }
        }
        return { html: '', statusCode: 0, pageState: { state: 'transport_error', reason: 'HTTP request failed' } };
    };

    const fetchWithPlaywright = async (url, { domExtractor = null } = {}) => {
        for (let attempt = 0; attempt < 2; attempt++) {
            let page = null;
            try {
                const b = await getBrowser();
                page = await b.newPage();
                await page.setExtraHTTPHeaders({
                    'accept-language': 'en-US,en;q=0.9',
                });
                await page.route('**/*.{mp4,webm,avi,woff,woff2}', (route) => route.abort());
                const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
                await page.waitForTimeout(2500);
                const statusCode = resp ? resp.status() : 200;
                const html = await page.content();
                const domData = domExtractor ? await page.evaluate(domExtractor) : null;
                return { html, statusCode, domData, pageState: detectAliExpressPageState(html, statusCode) };
            } catch (bErr) {
                const handled = await rotateOrDisableProxy(bErr);
                log.warning(`Browser fallback error for ${url}: ${bErr.message}`);
                if (!handled || attempt === 1) {
                    return { html: '', statusCode: 0, domData: null, pageState: { state: 'browser_error', reason: bErr.message } };
                }
            } finally {
                if (page) await page.close().catch(() => {});
            }
        }
        return { html: '', statusCode: 0, domData: null, pageState: { state: 'browser_error', reason: 'Playwright attempts exhausted' } };
    };

    let totalProductsScraped = 0;
    let freeShippingCount = 0;
    let totalOrdersCaptured = 0;
    const diagnostics = [];

    const hasExplicitUrls = Array.isArray(productUrls) && productUrls.length > 0;
    const hasExplicitKeywords = Array.isArray(searchKeywords) && searchKeywords.length > 0;
    const effectiveProductUrls = hasExplicitUrls ? productUrls : [];
    const effectiveSearchKeywords = hasExplicitKeywords
        ? searchKeywords
        : !hasExplicitUrls
            ? ['wireless earbuds']
            : [];

    // 1. Process Direct Product URLs
    if (effectiveProductUrls.length > 0) {
        log.info(`Processing ${effectiveProductUrls.length} direct AliExpress product URLs...`);

        for (const rawUrl of effectiveProductUrls) {
            const targetUrl = typeof rawUrl === 'string' ? rawUrl.trim() : rawUrl?.url?.trim();
            if (!targetUrl) continue;

            const itemId = extractAliExpressItemId(targetUrl);
            log.info(`Fetching AliExpress item: ${targetUrl}${itemId ? ` (ID: ${itemId})` : ''}`);
            let product = null;
            let lastReason = null;

            // Strategy A: HTTP
            const httpRes = await fetchHtmlWithHttp(targetUrl);
            if (httpRes.pageState.state === 'ok') {
                product = parseAliExpressProductHtml(httpRes.html, targetUrl);
            } else {
                lastReason = httpRes.pageState.reason;
                log.debug(`HTTP state for ${targetUrl}: ${httpRes.pageState.state} (${lastReason})`);
            }

            // Strategy B: Browser fallback (skip only if definitely 404/unavailable)
            if ((!product || !product.title) && httpRes.pageState.state !== 'unavailable') {
                log.info(`Launching browser renderer fallback for ${targetUrl}...`);
                const pwRes = await fetchWithPlaywright(targetUrl);
                if (pwRes.pageState.state === 'ok') {
                    product = parseAliExpressProductHtml(pwRes.html, targetUrl);
                }
                if (!product || !product.title) {
                    lastReason = pwRes.pageState.reason || lastReason;
                }
            }

            if (product && product.title) {
                await Actor.pushData(sanitizeRecord(product));
                totalProductsScraped++;
                if (product.shippingFee === 'Free Shipping') freeShippingCount++;
                if (product.ordersCountNumber) totalOrdersCaptured += product.ordersCountNumber;

                log.info(`[${totalProductsScraped}] Scraped: "${product.title.slice(0, 40)}..." | Orders: ${product.ordersCount || 'N/A'} | Price: $${product.price ?? 'N/A'}`);
            } else {
                const reasonMsg = lastReason || 'Target page returned no parseable product details';
                diagnostics.push({ target: targetUrl, reason: reasonMsg });
                log.warning(`Could not extract valid data from ${targetUrl}: ${reasonMsg}`);
            }

            await new Promise((r) => setTimeout(r, 1200));
        }
    }

    // 2. Process Search Keywords
    if (effectiveSearchKeywords.length > 0) {
        log.info(`Searching AliExpress for ${effectiveSearchKeywords.length} keywords...`);

        for (const keyword of effectiveSearchKeywords) {
            log.info(`Searching AliExpress for: "${keyword}" (max: ${maxProducts})`);

            let searchUrl = `https://www.aliexpress.com/w/wholesale-${encodeURIComponent(keyword)}.html`;
            if (sortBy === 'orders') searchUrl += '?sortType=total_tranpro_desc';
            else if (sortBy === 'priceAsc') searchUrl += '?sortType=price_asc';
            else if (sortBy === 'priceDesc') searchUrl += '?sortType=price_desc';
            else if (sortBy === 'rating') searchUrl += '?sortType=evaluation_desc';

            try {
                let results = [];
                let lastReason = null;

                const httpRes = await fetchHtmlWithHttp(searchUrl);
                if (httpRes.pageState.state === 'ok') {
                    results = parseAliExpressSearchHtml(httpRes.html);
                } else {
                    lastReason = httpRes.pageState.reason;
                }

                if (results.length === 0) {
                    log.info(`Using browser fallback for AliExpress search "${keyword}"...`);
                    const pwRes = await fetchWithPlaywright(searchUrl, {
                        domExtractor: () => {
                            const anchors = [...document.querySelectorAll('a[href*="/item/"]')];
                            const seen = new Set();
                            const out = [];
                            for (const a of anchors) {
                                const href = a.getAttribute('href') || '';
                                const absUrl = href.startsWith('//') ? `https:${href}` : href.startsWith('http') ? href : `https://www.aliexpress.com${href}`;
                                const clean = absUrl.split('?')[0];
                                if (!/\/item\/\d{10,}\.html/.test(clean) || seen.has(clean)) continue;
                                seen.add(clean);
                                const card = a.closest('[class*="card"], [class*="gallery"], [class*="search-item"], div') || a;
                                const titleEl = card.querySelector('h1, h2, h3, [class*="title"]');
                                const title = (titleEl?.innerText || a.getAttribute('title') || a.innerText || '').trim();
                                if (!title || title.length < 4) continue;
                                const cardText = card.innerText || '';
                                const priceMatch = cardText.match(/US\s*\$[\d.,]+|\$[\d.,]+/i);
                                const soldMatch = cardText.match(/(\d[\d,]*\+?\s*sold)/i);
                                const img = card.querySelector('img')?.getAttribute('src') || null;
                                out.push({
                                    url: clean,
                                    title,
                                    rawPrice: priceMatch ? priceMatch[0] : null,
                                    ordersCount: soldMatch ? soldMatch[1] : null,
                                    thumbnail: img && img.startsWith('//') ? `https:${img}` : img,
                                    isFreeShipping: cardText.toLowerCase().includes('free shipping'),
                                });
                            }
                            return out;
                        },
                    });
                    if (pwRes.pageState.state === 'ok') {
                        results = parseAliExpressSearchHtml(pwRes.html);
                        if (results.length === 0 && Array.isArray(pwRes.domData) && pwRes.domData.length > 0) {
                            results = pwRes.domData.map((d) => ({
                                itemId: extractAliExpressItemId(d.url),
                                title: d.title,
                                price: d.rawPrice ? parseFloat(d.rawPrice.replace(/[^0-9.]/g, '')) || null : null,
                                currency: 'USD',
                                ordersCount: d.ordersCount,
                                ordersCountNumber: d.ordersCount ? parseInt(d.ordersCount.replace(/[^\d]/g, ''), 10) || 0 : 0,
                                rating: null,
                                shippingFee: d.isFreeShipping ? 'Free Shipping' : 'Paid Shipping',
                                thumbnail: d.thumbnail,
                                url: d.url,
                                scrapedAt: new Date().toISOString(),
                            }));
                        }
                    } else {
                        lastReason = pwRes.pageState.reason || lastReason;
                    }
                }

                if (results.length === 0) {
                    diagnostics.push({ target: searchUrl, reason: lastReason || `No search results parsed for "${keyword}"` });
                }

                const sliced = results.slice(0, maxProducts);
                for (const item of sliced) {
                    item.searchKeyword = keyword;
                    await Actor.pushData(sanitizeRecord(item));
                    totalProductsScraped++;
                    if (item.shippingFee === 'Free Shipping') freeShippingCount++;
                    if (item.ordersCountNumber) totalOrdersCaptured += item.ordersCountNumber;
                }

                log.info(`Extracted ${sliced.length} search results for "${keyword}"`);
            } catch (searchErr) {
                log.error(`Error searching AliExpress for "${keyword}": ${searchErr.message}`);
            }
        }
    }

    await closeBrowser();

    const summary = {
        totalProductsScraped,
        freeShippingCount,
        totalOrdersCaptured,
        shipToCountry: cleanCountry,
        diagnostics,
        status: totalProductsScraped > 0 ? 'SUCCEEDED' : 'FAILED',
        scrapedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', summary);
    if (totalProductsScraped === 0) {
        const hint = diagnostics[0]?.reason ? ` (${diagnostics[0].reason})` : '';
        await Actor.fail(`Extracted 0 products. Verify target URLs, keywords, or proxy configuration${hint}.`);
    }
    log.info(`AliExpress Scraping finished successfully! Total items: ${totalProductsScraped}`);
} catch (err) {
    await closeBrowser();
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message });
    await Actor.fail(err.message);
} finally {
    await closeBrowser();
    await Actor.exit();
}

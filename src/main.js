import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { chromium } from 'playwright';
import {
    extractAliExpressItemId,
    parseAliExpressProductHtml,
    parseAliExpressSearchHtml,
} from './extractors.js';

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const {
        productUrls = [
            'https://www.aliexpress.com/item/1005006245389123.html',
        ],
        searchKeywords = [],
        sortBy = 'orders',
        shipToCountry = 'US',
        maxProducts = 40,
        proxyConfiguration,
    } = input;

    log.info(`Starting AliExpress Dropshipping Scraper (Ship to: ${shipToCountry}, Sort: ${sortBy})...`);

    // Setup Proxy
    let proxyUrl = undefined;
    if (proxyConfiguration) {
        const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
        if (proxyConfig) {
            proxyUrl = await proxyConfig.newUrl();
            log.info('Proxy enabled successfully');
        }
    }

    let totalProductsScraped = 0;
    let freeShippingCount = 0;
    let totalOrdersCaptured = 0;

    // Browser Helper for Anti-Bot Fallback
    let browser = null;
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

    // 1. Process Direct Product URLs
    if (Array.isArray(productUrls) && productUrls.length > 0) {
        log.info(`Processing ${productUrls.length} direct AliExpress product URLs...`);

        for (const rawUrl of productUrls) {
            const targetUrl = typeof rawUrl === 'string' ? rawUrl : rawUrl?.url;
            if (!targetUrl) continue;

            log.info(`Fetching AliExpress item: ${targetUrl}`);
            let product = null;

            // Strategy A: gotScraping
            try {
                const response = await gotScraping({
                    url: targetUrl,
                    proxyUrl,
                    headers: {
                        'accept-language': 'en-US,en;q=0.9',
                        'cookie': `aep_usuc_f=site=glo&c_tp=USD&region=${shipToCountry}&b_locale=en_US;`,
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                    },
                    timeout: { request: 30000 },
                });

                const html = response.body;
                if (!html.includes('punish') && !html.includes('sec.aliexpress.com')) {
                    product = parseAliExpressProductHtml(html, targetUrl);
                }
            } catch (err) {
                log.debug(`gotScraping error for ${targetUrl}: ${err.message}`);
            }

            // Strategy B: Browser fallback
            if (!product || !product.title) {
                try {
                    log.info(`Launching browser renderer fallback for ${targetUrl}...`);
                    const b = await getBrowser();
                    const page = await b.newPage();
                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                    await page.waitForTimeout(2500);

                    const html = await page.content();
                    product = parseAliExpressProductHtml(html, targetUrl);
                    await page.close();
                } catch (bErr) {
                    log.warning(`Browser fallback error for ${targetUrl}: ${bErr.message}`);
                }
            }

            if (product && product.title) {
                await Actor.pushData(product);
                totalProductsScraped++;
                if (product.shippingFee === 'Free Shipping') freeShippingCount++;
                if (product.ordersCountNumber) totalOrdersCaptured += product.ordersCountNumber;

                log.info(`[${totalProductsScraped}] Scraped: "${product.title.slice(0, 40)}..." | Orders: ${product.ordersCount || 'N/A'} | Price: $${product.price ?? 'N/A'}`);
            } else {
                log.warning(`Could not extract valid data from: ${targetUrl}`);
            }

            // Polite delay
            await new Promise((r) => setTimeout(r, 1500));
        }
    }

    // 2. Process Search Keywords
    if (Array.isArray(searchKeywords) && searchKeywords.length > 0) {
        log.info(`Searching AliExpress for ${searchKeywords.length} keywords...`);

        for (const keyword of searchKeywords) {
            log.info(`Searching AliExpress for: "${keyword}" (max: ${maxProducts})`);

            let searchUrl = `https://www.aliexpress.com/w/wholesale-${encodeURIComponent(keyword)}.html`;
            if (sortBy === 'orders') searchUrl += '?sortType=total_tranpro_desc';
            else if (sortBy === 'priceAsc') searchUrl += '?sortType=price_asc';
            else if (sortBy === 'priceDesc') searchUrl += '?sortType=price_desc';

            try {
                let html = null;

                try {
                    const response = await gotScraping({
                        url: searchUrl,
                        proxyUrl,
                        headers: {
                            'accept-language': 'en-US,en;q=0.9',
                            'cookie': `aep_usuc_f=site=glo&c_tp=USD&region=${shipToCountry}&b_locale=en_US;`,
                            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                        },
                        timeout: { request: 30000 },
                    });
                    html = response.body;
                } catch (err) {
                    log.debug(`Direct search error: ${err.message}`);
                }

                if (!html || html.includes('punish') || html.includes('sec.aliexpress.com')) {
                    const b = await getBrowser();
                    const page = await b.newPage();
                    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                    await page.waitForTimeout(3000);
                    html = await page.content();
                    await page.close();
                }

                const results = parseAliExpressSearchHtml(html);
                const sliced = results.slice(0, maxProducts);

                for (const item of sliced) {
                    item.searchKeyword = keyword;
                    await Actor.pushData(item);
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

    if (browser) {
        await browser.close();
    }

    // Save final executive summary
    const summary = {
        totalProductsScraped,
        freeShippingCount,
        totalOrdersCaptured,
        shipToCountry,
        status: 'SUCCEEDED',
        scrapedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', summary);
    log.info(`AliExpress Scraping finished successfully! Total items: ${totalProductsScraped}`);

} catch (err) {
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message });
} finally {
    await Actor.exit();
}

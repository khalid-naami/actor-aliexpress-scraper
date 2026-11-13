/**
 * AliExpress Product & Search Extraction Handlers
 */

/**
 * Extract numerical AliExpress item ID from URL
 */
export function extractAliExpressItemId(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/\/item\/(\d{10,})\.html/) || url.match(/item\/(\d{10,})/) || url.match(/itemId=(\d{10,})/);
    return match ? match[1] : null;
}

/**
 * Clean numeric price
 */
export function parseAliPrice(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (!raw || typeof raw !== 'string') return null;
    const cleaned = raw.replace(/[^0-9.,]/g, '').trim();
    if (!cleaned) return null;
    if (cleaned.includes(',') && !cleaned.includes('.')) {
        return parseFloat(cleaned.replace(',', '.'));
    }
    return parseFloat(cleaned.replace(/,/g, ''));
}

/**
 * Clean numeric orders count (e.g. "5,000+ sold" -> 5000)
 */
export function parseAliOrdersCount(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : 0;
    if (!raw || typeof raw !== 'string') return 0;
    const digits = raw.replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : 0;
}

/**
 * Clean star rating
 */
export function parseAliRating(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (!raw || typeof raw !== 'string') return null;
    const match = raw.replace(',', '.').match(/([0-5]\.[0-9]|[0-5])/);
    return match ? parseFloat(match[1]) : null;
}

/**
 * Parse product details from AliExpress Product HTML
 */
export function parseAliExpressProductHtml(html, url = '') {
    if (!html) return null;

    const itemId = extractAliExpressItemId(url);

    // 1. Check for JSON-LD schema first
    let ldData = null;
    try {
        const ldMatches = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
        if (ldMatches) {
            for (const script of ldMatches) {
                const jsonText = script.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
                const d = JSON.parse(jsonText);
                if (d['@type'] === 'Product') {
                    ldData = d;
                    break;
                }
            }
        }
    } catch {
        // Fallback
    }

    // Title
    let title = ldData?.name || null;
    if (!title) {
        const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
                           html.match(/data-pl="product-title"[^>]*>([\s\S]*?)<\/h1>/i);
        if (titleMatch) title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
    }

    // Price
    let price = ldData?.offers?.price ? parseAliPrice(String(ldData.offers.price)) : null;
    let originalPrice = null;
    let currency = ldData?.offers?.priceCurrency || 'USD';

    const currentPriceMatch = html.match(/class="[^"]*(?:product-price-current|currentPrice|price--current)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/i);
    if (currentPriceMatch && price === null) {
        price = parseAliPrice(currentPriceMatch[1]);
    }

    const origPriceMatch = html.match(/class="[^"]*(?:product-price-original|originPrice|price--original)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/i);
    if (origPriceMatch) {
        originalPrice = parseAliPrice(origPriceMatch[1]);
    }

    // Discount percentage
    let discount = null;
    if (price && originalPrice && originalPrice > price) {
        const pct = Math.round(((originalPrice - price) / originalPrice) * 100);
        discount = `-${pct}%`;
    }

    // Orders Count (Key for winning products)
    let ordersCount = null;
    let ordersCountNumber = 0;
    const ordersMatch = html.match(/(\d[\d,]*\+?\s*sold)/i) ||
                        html.match(/class="[^"]*trade--trade--[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (ordersMatch) {
        ordersCount = ordersMatch[1].replace(/<[^>]+>/g, '').trim();
        ordersCountNumber = parseAliOrdersCount(ordersCount);
    }

    // Rating & Reviews
    let rating = ldData?.aggregateRating?.ratingValue ? parseFloat(ldData.aggregateRating.ratingValue) : null;
    let reviewsCount = ldData?.aggregateRating?.reviewCount ? parseInt(ldData.aggregateRating.reviewCount, 10) : 0;

    if (rating === null) {
        const ratingMatch = html.match(/class="[^"]*(?:overview-rating|rating--score)[^"]*"[^>]*>([\s\S]*?)<\/(?:strong|span)>/i) ||
                            html.match(/(\d\.\d)\s*\/\s*5/);
        if (ratingMatch) rating = parseAliRating(ratingMatch[1]);
    }

    if (reviewsCount === 0) {
        const revMatch = html.match(/(\d[\d,]*)\s*(?:Reviews|Customer Reviews)/i);
        if (revMatch) reviewsCount = parseInt(revMatch[1].replace(/,/g, ''), 10);
    }

    // Store Information
    let storeName = null;
    let storeRating = null;
    const storeMatch = html.match(/class="[^"]*(?:store-detail|store-info--name)[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span)>/i) ||
                       html.match(/"storeName":"([^"]+)"/);
    if (storeMatch) storeName = storeMatch[1].replace(/<[^>]+>/g, '').trim();

    const storeRatingMatch = html.match(/(\d{2,3}(?:\.\d+)?%)\s*(?:Positive feedback|positive)/i);
    if (storeRatingMatch) storeRating = storeRatingMatch[1];

    // Shipping
    let shippingFee = 'Free Shipping';
    let shippingMethod = 'AliExpress Standard Shipping';
    let deliveryDate = null;

    const shipMatch = html.match(/class="[^"]*dynamic-shipping[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (shipMatch) {
        const shipText = shipMatch[1].replace(/<[^>]+>/g, ' ').trim();
        if (shipText.toLowerCase().includes('free shipping')) shippingFee = 'Free Shipping';
        else {
            const feeVal = shipText.match(/\$[\d.]+/);
            if (feeVal) shippingFee = feeVal[0];
        }

        const deliveryMatch = shipText.match(/Delivery:?\s*([A-Za-z]+\s*\d+)/i);
        if (deliveryMatch) deliveryDate = deliveryMatch[1];
    }

    // Gallery Images
    const images = [];
    if (Array.isArray(ldData?.image)) {
        images.push(...ldData.image);
    }

    const imgMatches = [...html.matchAll(/class="[^"]*(?:gallery--image|magnifier--image)[^"]*"[^>]*src="([^"]+)"/gi)];
    for (const m of imgMatches) {
        let src = m[1];
        if (src.startsWith('//')) src = `https:${src}`;
        src = src.replace(/_\d+x\d+.*\.jpg$/, '');
        images.push(src);
    }

    const thumbnail = images[0] || (ldData?.image ? (Array.isArray(ldData.image) ? ldData.image[0] : ldData.image) : null);

    return {
        itemId,
        title,
        price,
        originalPrice,
        discount,
        currency,
        ordersCount,
        ordersCountNumber,
        rating,
        reviewsCount,
        storeName,
        storeRating,
        shippingFee,
        shippingMethod,
        deliveryDate,
        thumbnail,
        images: [...new Set(images)],
        url,
        scrapedAt: new Date().toISOString(),
    };
}

/**
 * Parse search results cards from AliExpress Search SERP HTML
 */
export function parseAliExpressSearchHtml(html) {
    const results = [];
    if (!html) return results;

    const cards = [...html.matchAll(/class="[^"]*(?:search-item-card|list--gallery--|search-card-item)[^"]*"[\s\S]*?(?=(?:class="[^"]*(?:search-item-card|list--gallery--|search-card-item)"|$))/gi)];

    for (const c of cards) {
        const cardHtml = c[0];

        // Link & Item ID
        const linkMatch = cardHtml.match(/href="(\/\/[^"]*aliexpress\.com\/item\/\d+\.html[^"]*)"/i) ||
                          cardHtml.match(/href="([^"]*\/item\/\d+\.html[^"]*)"/i);
        if (!linkMatch) continue;

        let href = linkMatch[1];
        if (href.startsWith('//')) href = `https:${href}`;
        const cleanUrl = href.split('?')[0];
        const itemId = extractAliExpressItemId(cleanUrl);

        // Title
        const titleMatch = cardHtml.match(/class="[^"]*(?:multi--titleText--|title--)[^"]*"[^>]*>([\s\S]*?)<\/(?:h1|h3|span)>/i);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : null;
        if (!title) continue;

        // Price
        const priceMatch = cardHtml.match(/class="[^"]*price--currentPrice--[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
                           cardHtml.match(/class="[^"]*price--[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
        const price = priceMatch ? parseAliPrice(priceMatch[1]) : null;

        // Orders (Sold count)
        let ordersCount = null;
        let ordersCountNumber = 0;
        const ordersMatch = cardHtml.match(/(\d[\d,]*\+?\s*sold)/i);
        if (ordersMatch) {
            ordersCount = ordersMatch[1].trim();
            ordersCountNumber = parseAliOrdersCount(ordersCount);
        }

        // Rating
        const ratingMatch = cardHtml.match(/class="[^"]*evaluation--score--[^"]*"[^>]*>([0-5]\.[0-9]|[0-5])<\/span>/i);
        const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

        // Thumbnail
        const imgMatch = cardHtml.match(/<img[^>]*src="([^"]+)"/i);
        let thumbnail = imgMatch ? imgMatch[1] : null;
        if (thumbnail && thumbnail.startsWith('//')) thumbnail = `https:${thumbnail}`;

        // Free Shipping
        const isFreeShipping = cardHtml.toLowerCase().includes('free shipping');

        results.push({
            itemId,
            title,
            price,
            currency: 'USD',
            ordersCount,
            ordersCountNumber,
            rating,
            shippingFee: isFreeShipping ? 'Free Shipping' : 'Paid Shipping',
            thumbnail,
            url: cleanUrl,
            scrapedAt: new Date().toISOString(),
        });
    }

    return results;
}

# 🚢 AliExpress Dropshipping Scraper (Winning Products, Orders & Shipping)

Extract live AliExpress products, sales order volume, active discounted prices, customer ratings, SKU variants, store feedback, and shipping methods at scale.

> **Apify Store Short Description (294 chars):**  
> `Scrape AliExpress products, winning dropshipping items, order volume, live prices, customer reviews, variants, and shipping options at scale. Supports sorting by orders (best sellers) and keyword search with residential proxy rotation for Shopify dropshipping, product research, and e-commerce.`

---

## 🌟 Key Features

- 🏆 **Winning Product Discovery**: Sort search results by total orders (`orders`) to uncover top-selling viral dropshipping items.
- 📦 **Order Volume Intelligence**: Captures exact sales numbers (e.g. "5,000+ sold") to measure real market demand.
- 💰 **Discounts & Live Pricing**: Extracts current promotional price, original retail price, and discount percentage (e.g. "-60%").
- 🚚 **Shipping & Delivery Tracking**: Extracts shipping fee ("Free Shipping" vs paid carrier), service method, and estimated delivery dates.
- ⭐ **Seller Credibility**: Extracts store name, positive feedback rating percentage (e.g. "98.4%"), and store followers.
- 🖼️ **HD Gallery Images**: High-resolution product images and review photos for e-commerce advertising.
- 🌍 **Ship-To Geolocation**: Supports custom country targeting (`shipToCountry`) to extract accurate local shipping costs and currencies.
- 🛡️ **Anti-Ban Architecture**: Bypasses AliExpress anti-scraping punisher redirects using Apify residential proxies.

---

## 📥 Input Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `productUrls` | Array | `["https://www.aliexpress.com/item/..."]` | List of direct AliExpress item links. |
| `searchKeywords` | Array | `[]` | Keywords to search on AliExpress (e.g. `'sunset lamp'`). |
| `sortBy` | String | `"orders"` | Sort order: `orders` (winning products), `default`, `priceAsc`, `priceDesc`, `rating`. |
| `shipToCountry` | String | `"US"` | Country destination code for shipping calculation (e.g. `US`, `GB`, `FR`, `DE`, `SA`). |
| `maxProducts` | Integer | `40` | Maximum product records to extract per keyword. |
| `proxyConfiguration` | Object | `{ "useApifyProxy": true }` | Apify Proxy settings to bypass IP blocks. |

---

## 📤 Output Data Format

```json
{
  "itemId": "1005006245389123",
  "title": "Sunset Projection Lamp Rainbow Atmosphere Led Night Light for Room Decor",
  "price": 4.89,
  "originalPrice": 12.50,
  "discount": "-61%",
  "currency": "USD",
  "ordersCount": "8,000+ sold",
  "ordersCountNumber": 8000,
  "rating": 4.8,
  "reviewsCount": 1640,
  "storeName": "Lumina Official Store",
  "storeRating": "97.8% positive",
  "shippingFee": "Free Shipping",
  "shippingMethod": "AliExpress Standard Shipping",
  "deliveryDate": "Delivery: Nov 25",
  "thumbnail": "https://ae01.alicdn.com/kf/S123456789.jpg",
  "images": [
    "https://ae01.alicdn.com/kf/S123456789.jpg",
    "https://ae01.alicdn.com/kf/S987654321.jpg"
  ],
  "url": "https://www.aliexpress.com/item/1005006245389123.html",
  "scrapedAt": "2026-11-10T12:10:00.000Z"
}
```

---

## 💡 Practical Dropshipping Use Cases

1. **Winning Product Scouting**: Automate daily searches sorted by order volume to detect breakout consumer trends early.
2. **Shopify Product Import**: Export clean product titles, high-res images, and pricing to populate your Shopify store.
3. **Price Arbitrage & Margin Analysis**: Benchmark supplier costs against Amazon and TikTok Shop retail prices.
4. **Supplier Quality Verification**: Filter out low-rated suppliers by vetting feedback percentages and order counts.

---

## ⚖️ License
Apache-2.0

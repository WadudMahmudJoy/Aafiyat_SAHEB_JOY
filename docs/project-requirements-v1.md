# Aafiyat — Project Requirements V1

Task 001 requirements baseline. This is a new implementation; the separate older Aafiyat project must not be accessed, copied, or modified.

## Brand and storefront

- Premium, luxurious, heritage-inspired Aafiyat menswear brand.
- Initial categories: T-Shirt, Half Shirt, Full Shirt, Panjabi, Sherwani.
- Responsive, fast, SEO-friendly multi-page storefront.
- Individual product URLs for Facebook/Meta campaigns.
- Product galleries, size/color variants, size guides, Buy Now, and Add to Cart.
- Modern, simple customer experience.

## Customers and checkout

- Guest checkout and optional customer accounts.
- Checkout captures name, phone, and address, with browser autofill support.
- Registered customers may access verified order history.
- Avoid duplicate customer profiles while preserving order-specific snapshots.
- Promotional consent UI must be admin-configurable.
- Hiding consent UI never implies consent.

## Payments and shipping

- Integrate SSLCOMMERZ for merchant-enabled payment methods.
- Verify payments server-side.
- Shipping is free when the post-discount merchandise subtotal is strictly greater than BDT 5,000; equality does not qualify under this rule.
- Admin can change the free-shipping threshold.
- Store money using exact decimal or integer minor-unit representations.

## Inventory and products

- Size/color/SKU-level inventory.
- Public stock status: In Stock, Low Stock, Out of Stock.
- Exact stock quantity remains internal.
- Low-stock threshold is configurable.
- Customers seeking additional quantities can contact the shop.
- Support discontinued and archived products.
- Preserve historical orders and perform safe media cleanup.

## Orders

- Order history includes date, time, status, and items.
- Red numeric badge for new, unacknowledged orders.
- Separate payment and fulfilment statuses.
- Transaction-safe stock handling.
- Three-day exchange policy.
- Delivery-based exchange start time requires business confirmation.

## Admin

- Keep navigation and workflows simple.
- Manage products, variants, inventory, orders, customers, content, media, offers, and settings.
- Admin MFA, authorization, activity auditing, and secure sessions.
- Homepage content and business settings are editable.
- No unnecessary enterprise complexity.

## Reviews

- Reviews are disabled and hidden in V1.
- Keep architecture extensible for later optional reviews.
- Future reviews require admin moderation before public display.
- Do not implement the review module now.

## Architecture

- Next.js, TypeScript, PostgreSQL, and Prisma are proposed, pending final selection.
- Modular monolith architecture.
- Cloud object storage and CDN for product media.
- Managed cloud infrastructure is preferred.
- Final hosting/database providers are not yet locked.
- Design for growth without premature microservices.

## Unresolved decisions requiring business confirmation

- Confirm whether the three-day exchange window starts at delivery.
- Confirm adoption of the proposed Next.js, TypeScript, PostgreSQL, and Prisma stack.
- Confirm final hosting and database providers.

# Synthetic OCR fixture

`synthetic-tbank-scan.jpg` is a frozen, generated 2000 × 1400 raster, not a real statement. Every amount, date and identifier is artificial. The account consists of nineteen zeroes and a final one. Its row contains 01.09.2026, 02.09.2026 and −10.01 RUB.

The image supplies the known T-bank table geometry used by the parser fixtures. It is wrapped in an image-only PDF by `syntheticImagePdf` for the real PDF.js → local OCR → import test. Freezing the pixels removes host-font differences from that test. The pinned Russian/English model recognizes all its words above the unchanged 85 confidence threshold (native fixture check: minimum 90, overall 94). OCR output still has no merchant, bank-reference HMAC or description HMAC.

Low-confidence rejection remains covered separately. This fixture does not establish real-bank, Safari or device acceptance.

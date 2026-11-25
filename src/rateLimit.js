function createRateLimiter({ writeMax = 120, readMax = 600, windowMs = 60_000 } = {}) {
  const buckets = new Map();

  return function rateLimit(req, res, next) {
    if (req.path === "/health" || req.path.startsWith("/__test/")) return next();
    const isWrite = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
    const max = isWrite ? writeMax : readMax;
    const now = Date.now();
    const key = `${isWrite ? "w" : "r"}:${req.ip || "unknown"}`;
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 5000) {
      for (const [bucketKey, value] of buckets) {
        if (now - value.start >= windowMs) buckets.delete(bucketKey);
      }
    }
    if (bucket.count <= max) return next();

    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - bucket.start)) / 1000));
    res.set("Retry-After", String(retryAfter));
    const wantsJson = req.path.startsWith("/api/")
      || req.path.endsWith(".json")
      || req.get("accept") === "application/json";
    if (wantsJson) return res.status(429).json({ errors: ["Rate limit exceeded"] });
    return res.status(429).type("text/plain").send("Rate limit exceeded");
  };
}

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

module.exports = { createRateLimiter, readPositiveInt };

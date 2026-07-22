// node tick.mjs
const iterations = 200;

const t0 = performance.now();

for (let i = 0; i < iterations; i++) {
  await new Promise(resolve => setTimeout(resolve, 0));
}

console.log(
  "setTimeout(0):",
  ((performance.now() - t0) / iterations * 1000).toFixed(0),
  "us/tick",
);

const t1 = performance.now();

for (let i = 0; i < iterations; i++) {
  await new Promise(resolve => setImmediate(resolve));
}

console.log(
  "setImmediate:",
  ((performance.now() - t1) / iterations * 1000).toFixed(0),
  "us/tick",
);
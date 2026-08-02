// Manual test script for the AI gateway integration (this repo has no
// automated test runner -- run with: node test-ai-gateway.js).
//
// What it checks:
//  1. Safe-degrade behavior when AI_GATEWAY_URL/AI_GATEWAY_KEY are missing
//     (must never throw, must return skipped:true).
//  2. If AI_GATEWAY_KEY IS set in your environment/.env, makes one real call
//     and prints the raw response so you can confirm aiGateway.js is parsing
//     it correctly (the exact gateway response shape wasn't documented
//     anywhere I could find -- see the comment at the top of aiGateway.js).
require('dotenv').config();

async function main() {
  console.log('=== 1. Safe-degrade when gateway is not configured ===');
  delete process.env.AI_GATEWAY_URL;
  delete process.env.AI_GATEWAY_KEY;
  delete require.cache[require.resolve('./aiGateway')];
  delete require.cache[require.resolve('./llm')];
  const llmNoConfig = require('./llm');
  const r1 = await llmNoConfig.summarizeAgreement('a'.repeat(200));
  console.log('summarizeAgreement() with no gateway configured ->', r1);
  console.log(r1.skipped === true && r1.summary === null ? 'PASS: degraded safely, did not throw' : 'FAIL: unexpected result');

  console.log('\n=== 2. Real gateway call (only if AI_GATEWAY_URL/KEY are set) ===');
  require('dotenv').config({ override: true });
  if (!process.env.AI_GATEWAY_URL || !process.env.AI_GATEWAY_KEY) {
    console.log('Skipped: set AI_GATEWAY_URL and AI_GATEWAY_KEY in .env to run this part.');
    return;
  }
  delete require.cache[require.resolve('./aiGateway')];
  delete require.cache[require.resolve('./llm')];
  const aiGateway = require('./aiGateway');
  const res = await aiGateway.run('Reply with exactly the word: OK', { maxTokens: 10 });
  console.log('Raw aiGateway.run() result:', res);
  if (res.ok) {
    console.log('PASS: gateway responded and a text field was recognized.');
  } else {
    console.log('No text recognized. If the gateway IS working, check the console.warn output above');
    console.log('for the HTTP status, then compare your gateway\'s real response shape against');
    console.log('the extractText() field list in aiGateway.js and add the missing field name there.');
  }
}

main().catch(err => { console.error('Unexpected error in test script itself:', err.message); process.exit(1); });

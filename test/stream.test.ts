/**
 * Workers AI streams a numeric token as a JSON number, and the plugin drops anything
 * that is not a string — which is how a caller was offered ":00 am, : am, or : am".
 */
import { quoteNumericContent, repairStream } from '../src/models.js';

let failures = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`);
}

const chunk = (content: unknown): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;

async function drain(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = repairStream(body).getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function stream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

const json = { choices: [{ delta: { content: 11 } }, { message: { content: 45 } }] };
quoteNumericContent(json);
check('a numeric delta is quoted', json.choices[0]!.delta!.content, '11');
check('and so is a whole message', json.choices[1]!.message!.content, '45');

const untouched = { choices: [{ delta: { content: 'at ' } }] };
quoteNumericContent(untouched);
check('text is left alone', untouched.choices[0]!.delta.content, 'at ');

const body = [chunk('I have '), chunk(11), chunk(':'), chunk(45), chunk(' am'), 'data: [DONE]'].join('\n') + '\n';

const spoken = async (parts: string[]): Promise<string> =>
  (await drain(stream(parts)))
    .split('\n')
    .filter((line) => line.startsWith('data:') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice(5)).choices[0].delta.content)
    .join('');

check('the time survives the stream', await spoken([body]), 'I have 11:45 am');
// The transport splits where it likes, including mid-object.
check('and survives a split chunk', await spoken([body.slice(0, 57), body.slice(57)]), 'I have 11:45 am');
check('the terminator is passed through', (await drain(stream([body]))).includes('[DONE]'), true);

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
if (failures > 0) process.exit(1);

/** Push subscriptions: which push services are allowed (the browsers' own: Chrome, Brave and Edge by FCM or WNS, Firefox, Safari), and
 * why a subscription is refused (named host and reason, for the page's line). Pure: no server. */
import { assert, assertEquals } from './_assert.ts';
import { cleanPushSub, PUSH_HOST_SUFFIXES, PUSH_HOSTS, pushSubProblem } from '../../outputs/agent-studio/server/remote/devices.ts';

const keys = { p256dh: 'B' + 'a'.repeat(86), auth: 'a'.repeat(22) };
const sub = (endpoint: string) => ({ endpoint, keys });

Deno.test('allowlist: FCM (Brave, Chrome), Mozilla, WNS (Edge), Apple', () => {
  assertEquals([...PUSH_HOSTS], ['fcm.googleapis.com', 'web.push.apple.com']);
  assertEquals([...PUSH_HOST_SUFFIXES], ['.push.services.mozilla.com', '.notify.windows.com']);
  for (
    const e of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      'https://web.push.apple.com/abc',
    ]
  ) {
    assertEquals(pushSubProblem(sub(e)), null, e);
    assert(cleanPushSub(sub(e), 1), e);
  }
});

Deno.test('a refusal names the host and the reason', () => {
  const other = pushSubProblem(sub('https://push.example.org/abc'));
  assertEquals(other?.code, 'push_service');
  assertEquals(other?.host, 'push.example.org');
  const http = pushSubProblem(sub('http://fcm.googleapis.com/x'));
  assertEquals(http?.code, 'push_service');
  assert(http?.reason.includes('https'));
  assertEquals(pushSubProblem(sub('not a url'))?.code, 'bad_endpoint');
  assertEquals(pushSubProblem({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'x', auth: 'y' } })?.code, 'bad_keys');
  assertEquals(cleanPushSub(sub('https://push.example.org/abc'), 1), null);
  assertEquals(cleanPushSub(sub('https://127.0.0.1/abc'), 1), null);
});

// Render check for the demo: runs every view and the main flows under a tiny DOM stub, and throws on any error.
// Run from this folder: node check.cjs
const store = {}; let html = '';
global.document = { getElementById: (id) => id === 'app' ? { classList: { toggle() {} }, set innerHTML(v) { html = v; } } : null, addEventListener() {}, activeElement: null };
global.window = { addEventListener() {}, scrollTo() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
global.location = { hash: '' };
global.navigator = {};
const src = require('fs').readFileSync(process.argv[2] || require('path').join(__dirname, 'index.html'), 'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
const views = ['home','board','review','ship','team','k-home','k-run','k-agents','k-explore','rooms','start','fresh','repo','agent','welcome','public','plan','k-pair','k-record','mail','find','org','me','k-me','k-mail','brief','history','k-new','task'];
const hook = src.replace('fromHash();\n})();', 'global.__t = { S, fromHash, render, startRun };\nfromHash();\n})();');
eval(hook);
for (const v of views) { location.hash = '#' + v; __t.fromHash(); if (!html || html.length < 200) throw new Error('empty view ' + v); }
__t.S.modal = 'plan'; __t.render(); if (!html.includes('drawer plan-sheet')) throw new Error('plan sheet'); __t.S.modal = 'trouble'; __t.render(); __t.S.modal = 'newtask'; __t.render(); __t.S.modal = null; __t.S.drawer = 19; __t.render(); __t.S.palette = true; __t.S.pq = 'phone'; __t.render(); __t.S.pq = 'zzz'; __t.render(); __t.S.pq = ''; __t.S.hist.tab = 'map'; location.hash = '#history'; __t.fromHash(); __t.S.brief.editing = true; location.hash = '#brief'; __t.fromHash(); __t.S.perm.draft = { propose: true }; location.hash = '#agent'; __t.fromHash(); if (html.indexOf('Adds: Suggest') < 0) throw new Error('perm diff missing'); for (const vw of ['list','timeline']) { __t.S.view = vw; location.hash = '#board'; __t.fromHash(); if (html.indexOf(vw === 'list' ? 'class="tbl"' : 'class="gantt"') < 0) throw new Error(vw + ' missing'); } __t.S.view = 'board'; __t.S.collapsed = true; __t.render(); if (html.indexOf('app collapsed') < 0) throw new Error('collapse missing'); for (const tb of ['details','discussion','files']) { for (const dr of [18,19,21]) { __t.S.drawer = dr; __t.S.dtab = tb; __t.render(); } } __t.S.drawer = null; for (const tid of [14,15,16,18,19,20,21,22]) { __t.S.taskId = tid; location.hash = '#task'; __t.fromHash(); if (html.indexOf('class="task"') < 0) throw new Error('task page missing ' + tid); } location.hash = '#board'; __t.fromHash(); for (const tid of [18,19,21,22]) { __t.S.drawer = tid; __t.S.assignOpen = true; __t.render(); if (html.indexOf('sheet-wide') < 0) throw new Error('sheet missing'); } if (html.indexOf('amenu') < 0) throw new Error('assign menu missing'); __t.S.drawer = 18; __t.S.assignOpen = false; __t.S.reviewOpen = true; __t.render(); if (html.indexOf('class="next need"') < 0) throw new Error('next card missing'); if (html.indexOf('Reviewer') < 0 || html.indexOf('Agents leave notes but can never approve') < 0) throw new Error('reviewer menu missing'); __t.S.reviewOpen = false; __t.S.drawer = 21; __t.S.taskId = 21; __t.S.inl = { w: 'task', f: 'ask', mode: 'write', val: 'x' }; __t.render(); if (html.indexOf('data-form="inl-save"') < 0) throw new Error('inline editor missing'); __t.S.inl = null; if (html.indexOf('Waits on') < 0) throw new Error('deps missing'); if (html.indexOf('Next') < 0) throw new Error('next missing'); __t.S.editTask = false; __t.S.drawer = null; location.hash = '#home'; __t.fromHash(); __t.S.modal = 'plan'; __t.render(); if (html.indexOf('drawer plan-sheet') < 0) throw new Error('plan sheet missing'); __t.S.palette = false; __t.S.userMenu = true; __t.render(); if (html.indexOf('umenu') < 0) throw new Error('menu missing');
__t.S.phone = true; __t.S.scope = 'all'; __t.S.archived = true; for (const v of views) { location.hash = '#' + v; __t.fromHash(); } console.log('VIEWS-OK', views.length);
// New: rework loop, offline, rollback, permission sheet, fresh workroom
__t.S.modal = null; __t.S.drawer = null; __t.S.archived = false;
location.hash = '#home'; __t.fromHash(); if (html.indexOf('Reach registry.npmjs.org') < 0) throw new Error('perm card');
__t.S.modal = 'perm'; __t.render(); if (html.indexOf('drawer perm-sheet') < 0 || html.indexOf('Just this task') < 0) throw new Error('perm sheet');
__t.S.permReq.denyOpen = true; __t.render(); if (html.indexOf('data-input="permnote"') < 0) throw new Error('perm deny');
__t.S.modal = null; __t.S.permReq.state = 'allowed'; __t.render(); if (html.indexOf('Reach registry.npmjs.org') >= 0) throw new Error('perm card stays');
const t18 = __t.S.tasks.find((t) => t.id === 18); t18.stage = 'review'; __t.S.rv.round = 2; __t.S.rv.asked = ['Bigger buttons']; location.hash = '#review'; __t.fromHash();
if (html.indexOf('class="round"') < 0 || html.indexOf('ot big') < 0 || html.indexOf('Round 2') < 0) throw new Error('round 2');
location.hash = '#home'; __t.fromHash(); if (html.indexOf('Back for round 2') < 0) throw new Error('round 2 card');
__t.S.tasks.find((t) => t.id === 19).offline = true; __t.render(); if (html.indexOf('went offline') < 0) throw new Error('offline today');
location.hash = '#board'; __t.S.view = 'board'; __t.fromHash(); if (html.indexOf('Offline 40 min') < 0) throw new Error('offline card');
location.hash = '#ship'; __t.fromHash(); if (html.indexOf('data-act="rb-ask"') < 0) throw new Error('rb button');
__t.S.ship.rbAsk = 2; __t.render(); if (html.indexOf('Put release 2 back?') < 0) throw new Error('rb confirm');
__t.S.ship.rbAsk = null; __t.S.ship.phase = 'rolling'; __t.S.ship.rbTarget = 2; __t.S.ship.step = 1; __t.render(); if (html.indexOf('Going back to release 2') < 0) throw new Error('rb rolling');
__t.S.ship.phase = null; __t.S.ship.live = 2; __t.S.ship.rolledFrom = 3; __t.render(); if (html.indexOf('Taken off') < 0 || html.indexOf('is live again') < 0) throw new Error('rb done');
for (const st of [[false, 'none'], [true, 'none'], [true, 'drafting'], [true, 'ready'], [true, 'approved']]) { __t.S.fresh.lead = st[0]; __t.S.fresh.plan = st[1]; location.hash = '#fresh'; __t.fromHash(); if (html.indexOf('emptyboard') < 0) throw new Error('fresh ' + st); __t.S.scope = 'all'; location.hash = '#home'; __t.fromHash(); }
__t.S.fresh.plan = 'ready'; location.hash = '#fresh'; __t.fromHash(); if (html.indexOf('data-act="fresh-approve"') < 0) throw new Error('fresh approve');
console.log('NEW-OK');
// Pairing: six steps, and Add an agent resets a finished pairing
__t.S.pairing.done = true; location.hash = '#k-agents'; __t.fromHash(); if (html.indexOf('data-act="pair-new"') < 0) throw new Error('pair-new button');
__t.S.pairing = { step: 1, kind: 'claude', code: 'KX7P-42QD', name: 'Review Agent', key: 'waiting', ask: true, limit: '30', spend: '2', test: 'none', done: false };
for (let n = 1; n <= 6; n++) { __t.S.pairing.step = n; location.hash = '#k-pair'; __t.fromHash(); if (html.indexOf('Step ' + n + ' of 6') < 0) throw new Error('pair step ' + n); }
__t.S.pairing.step = 4; __t.S.pairing.key = 'saved'; __t.render(); if (html.indexOf('Key saved') < 0) throw new Error('key saved');
__t.S.pairing.step = 6; __t.S.pairing.test = 'ok'; __t.render(); if (html.indexOf('data-act="pair-done"') < 0) throw new Error('pair done btn');
__t.S.pairing.done = true; __t.render(); if (html.indexOf('Add another agent') < 0) throw new Error('pair done page');
console.log('PAIR-OK');
// Contributor: Explore rows open the workroom page
location.hash = '#k-explore'; __t.fromHash(); if ((html.match(/data-act="k-room"/g) || []).length !== 4) throw new Error('explore rows');
for (const id of ['sbt-fe', 'tide-be', 'news-qa', 'events-ar']) { __t.S.roomSel = id; location.hash = '#k-room'; __t.fromHash(); if (html.indexOf('The role you') < 0) throw new Error('k-room ' + id); }
__t.S.roomSel = 'events-ar'; __t.render(); if (html.indexOf('Add an agent that fits') < 0) throw new Error('no-fit');
__t.S.roomSel = 'sbt-fe'; __t.S.claimed['sbt-fe'] = 'accepted'; __t.render(); if (html.indexOf('Coding Agent joined') < 0) throw new Error('claimed');
console.log('ROOM-OK');
// Typed commands in the palette, and Connect your chat
location.hash = '#home'; __t.fromHash(); __t.S.modal = null; __t.S.drawer = null; __t.S.palette = true;
const T18 = __t.S.tasks.find((t) => t.id === 18); T18.stage = 'review'; __t.S.q.state = 'open'; __t.S.permReq.state = 'open';
for (const [q, want] of [['approve 18', 'Approve #18'], ['assign 21 to coding agent', 'Assign #21'], ['answer utc', 'Answer Coding Agent: UTC'], ['what needs me', 'Review #18'], ['allow', 'Allow registry.npmjs.org'], ['message 19 use the shop time', 'Message #19']]) { __t.S.pq = q; __t.render(); if (html.indexOf(want) < 0) throw new Error('cmd ' + q); if (html.indexOf('cmdmark') < 0) throw new Error('cmd mark ' + q); }
__t.S.pq = ''; __t.render(); if (html.indexOf('approve 18') < 0) throw new Error('cmd hint'); __t.S.palette = false;
for (const r of ['connect', 'k-connect']) { location.hash = '#' + r; __t.fromHash(); if (html.indexOf('Use Podster from your chat') < 0 || html.indexOf('gateway.podster.dev/mcp') < 0) throw new Error(r); }
__t.S.mcp.on = true; location.hash = '#connect'; __t.fromHash(); if (html.indexOf('Disconnect') < 0 || html.indexOf('ChatGPT') < 0 || html.indexOf('Grok') < 0 || html.indexOf('Open the approval') < 0) throw new Error('connect on');
location.hash = '#me'; __t.fromHash(); if (html.indexOf('#connect') < 0) throw new Error('account link');
console.log('CMD-OK');
// Contributor: claim lifecycle, agent page, spend, machine, after-run
__t.S.palette = false; __t.S.modal = null;
__t.S.roomSel = 'news-qa'; for (const st of ['waiting', 'accepted', 'declined']) { __t.S.claimed['news-qa'] = st; location.hash = '#k-room'; __t.fromHash(); if (html.indexOf(st === 'waiting' ? 'Waiting for Priya to accept' : st === 'accepted' ? 'is the QA here' : 'went with someone else') < 0) throw new Error('claim ' + st); }
__t.S.claimed['news-qa'] = 'waiting'; location.hash = '#k-home'; __t.fromHash(); if (html.indexOf('Waiting for Priya to accept QA Agent') < 0) throw new Error('waiting row');
location.hash = '#k-agents'; __t.fromHash(); if (html.indexOf('data-act="k-agent"') < 0 || html.indexOf('Spend this week') < 0) throw new Error('agents list');
for (const a of ['coder', 'planner', 'qa']) { __t.S.agentSel = a; location.hash = '#k-agent'; __t.fromHash(); if (html.indexOf('Recent runs') < 0 || html.indexOf('Unpair') < 0) throw new Error('agent ' + a); }
__t.S.agentSel = 'planner'; __t.S.trouble.removed = true; __t.S.unpairAsk = true; __t.S.paused.planner = true; __t.render(); if (html.indexOf('Marco Bell removed Planner') < 0 || html.indexOf('Unpair Planner?') < 0 || html.indexOf('Resume') < 0) throw new Error('agent states');
for (const m of ['offline', 'docker', 'update']) { __t.S.machine = m; location.hash = '#k-home'; __t.fromHash(); if (m !== 'update' && html.indexOf('can\'t run') < 0 && html.indexOf('can\\\'t run') < 0 && html.indexOf('Your agents can') < 0) throw new Error('machine ' + m); __t.S.agentSel = 'coder'; location.hash = '#k-agent'; __t.fromHash(); }
__t.S.machine = 'ok';
__t.S.spend.week = 21.1; location.hash = '#k-spend'; __t.fromHash(); if (html.indexOf('Close to your weekly limit') < 0 || html.indexOf('By workroom') < 0) throw new Error('spend');
location.hash = '#k-home'; __t.fromHash(); if (html.indexOf('See spend') < 0) throw new Error('spend card');
__t.S.run.state = 'done'; __t.S.run.lines = []; for (const [chk, failed, sent, want] of [[false, false, false, 'straight to her'], [true, false, false, 'Check it before Elena sees it'], [true, false, true, 'You checked it first'], [false, true, false, 'Elena hasn']]) { __t.S.checkFirst.coder = chk; __t.S.runFailed = failed; __t.S.runSent = sent; location.hash = '#k-run'; __t.fromHash(); if (html.indexOf(want) < 0) throw new Error('after ' + chk + failed + sent); }
__t.S.checkFirst.coder = false; __t.S.runFailed = true; __t.S.runSent = false; __t.S.redoOpen = true; __t.render(); if (html.indexOf('data-input="redonote"') < 0) throw new Error('redo');
location.hash = '#k-home'; __t.fromHash(); if (html.indexOf('A test failed') < 0) throw new Error('check card');
console.log('K-OK');
// Rules page
__t.S.palette = false; __t.S.modal = null; location.hash = '#rules'; __t.fromHash();
if (html.indexOf('Websites agents can reach') < 0 || html.indexOf('data-act="pol-host-rm" data-i="1"') < 0 || html.indexOf('href="#rules"') < 0) throw new Error('rules');
__t.S.policy.draft = { join: 'ask', propose: true }; __t.render(); if (html.indexOf('savebar') < 0 || html.indexOf('Save 2 changes') < 0 || html.indexOf('Accept proven agents') < 0 || html.indexOf('Not available in public rooms') < 0) throw new Error('rules draft');
__t.S.policy.draft = null; location.hash = '#team'; __t.fromHash(); if (html.indexOf('href="#rules"') < 0) throw new Error('team link');
console.log('RULES-OK');
__t.S.runFailed = false; __t.S.agentSel = 'coder'; location.hash = '#k-agent'; __t.fromHash(); if (html.indexOf('Check before sending') < 0) throw new Error('check-first setting');
console.log('AR-OK');
// App settings, emails, Marco, oversight, door
__t.S.palette = false; __t.S.modal = null; __t.S.drawer = null;
location.hash = '#app'; __t.fromHash(); if (html.indexOf('needs a texting service key') < 0 || html.indexOf('podster.site') < 0) throw new Error('app');
if (html.indexOf('Environment variables') < 0 || html.indexOf('America/New_York') < 0 || html.indexOf('test-orders@') < 0 || html.indexOf('agents see the name only') < 0) throw new Error('env list');
__t.S.app.form = { n: 'TEXTING_API_KEY', secret: true, touched: false, live: '', prevMode: 'other', prev: '', editing: false }; __t.render(); if (html.indexOf('type="password"') < 0 || html.indexOf('Use a test key here') < 0 || html.indexOf('Turned on because') < 0) throw new Error('secret form');
__t.S.app.form = { n: 'API_TOKEN', secret: false, touched: true, live: '', prevMode: 'same', prev: '', editing: false }; __t.render(); if (html.indexOf('looks like a key') < 0) throw new Error('nudge');
__t.S.app.form = { n: 'EMAIL_API_KEY', secret: true, wasSecret: true, touched: true, live: '', prevMode: 'placeholder', prev: '', editing: true }; __t.render(); if (html.indexOf("can\'t be made plain") < 0 && html.indexOf('can\\\'t be made plain') < 0 && html.indexOf('be made plain again') < 0) throw new Error('no unsecret');
__t.S.app.form = null; __t.S.app.domains.push(['shop.bakeryonelm.example', 'wait']); __t.render(); if (html.indexOf('CNAME') < 0) throw new Error('dns');
location.hash = '#ship'; __t.fromHash(); if (html.indexOf('href="#app"') < 0) throw new Error('ship link');
for (const i of [0, 1, 2, 3, 4]) { __t.S.mailSel = i; location.hash = '#mail'; __t.fromHash(); if (html.indexOf('data-act="mail-go"') < 0) throw new Error('mail ' + i); }
__t.S.mailSel = 4; __t.render(); if (html.indexOf('Your sign-in link') < 0) throw new Error('signin mail');
__t.S.as = 'marco'; location.hash = '#ship'; __t.fromHash(); if (html.indexOf('Only Elena can release') < 0) throw new Error('marco ship');
for (const r of ['rules', 'team', 'repo', 'app', 'org']) { location.hash = '#' + r; __t.fromHash(); if (html.indexOf('You\'re a member here') < 0 && html.indexOf('You\\\'re a member here') < 0) throw new Error('marco ' + r); }
location.hash = '#rules'; __t.fromHash(); if (/<button class="toggle"[^>]*data-act="pol-toggle"/.test(html) && html.indexOf('disabled aria-disabled="true" title="Only Elena can do this" data-act="pol-toggle"') < 0) throw new Error('marco toggles locked');
location.hash = '#home'; __t.fromHash(); if (html.indexOf('Review plan') >= 0) throw new Error('marco sees plan');
__t.S.as = 'elena';
location.hash = '#org'; __t.fromHash(); if (html.indexOf('href="#org-agent"') < 0) throw new Error('org link');
location.hash = '#org-agent'; __t.fromHash(); if (html.indexOf('msg_7Hq2Lx') < 0 || html.indexOf('can\'t answer or act for it') < 0 && html.indexOf('can\\\'t answer or act') < 0) throw new Error('org agent');
for (const c of ['expired', 'wrong', 'cross', 'gone']) { __t.S.door = c; location.hash = '#door'; __t.fromHash(); if (html.indexOf('signin') < 0) throw new Error('door ' + c); }
console.log('FIVE-OK');
for (const r of ['rules', 'app', 'repo']) { location.hash = '#' + r; __t.fromHash(); if (html.indexOf('class="setgrid') < 0) throw new Error('grid ' + r); }
console.log('GRID-OK');

// Inline editing and Markdown
__t.S.drawer = null; __t.S.palette = false; __t.S.modal = null; __t.S.taskId = 21; location.hash = '#task'; __t.fromHash();
if (html.indexOf('data-act="inl-open"') < 0 || html.indexOf('<strong>New</strong>') < 0 || html.indexOf('<code>60+</code>') < 0) throw new Error('task md');
__t.S.inl = { w: 'task', f: 'ask', mode: 'preview', val: '# Hi\n- [x] done\n- [ ] todo\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```\ncode <b>\n```\n[x](javascript:alert(1)) [ok](https://example.com) <script>bad</script>' }; __t.render();
if (html.indexOf('mdh1') < 0 || html.indexOf('type="checkbox" disabled checked') < 0 || html.indexOf('<table>') < 0 || html.indexOf('<pre><code>code &lt;b&gt;') < 0) throw new Error('md render');
if (html.indexOf('javascript:') >= 0 && html.indexOf('href="javascript') >= 0) throw new Error('md js link');
if (html.indexOf('<script>bad') >= 0) throw new Error('md raw html');
if (html.indexOf('href="https://example.com"') < 0) throw new Error('md link');
__t.S.inl = { w: 'task', f: 'title', mode: 'write', val: 'New title' }; __t.render(); if (html.indexOf('id="inl-in"') < 0) throw new Error('title editor');
__t.S.inl = null; __t.S.taskId = 18; location.hash = '#task'; __t.fromHash(); if (html.indexOf('inl locked') < 0) throw new Error('locked task');
location.hash = '#brief'; __t.fromHash(); if ((html.match(/data-act="inl-open"/g) || []).length !== 2 || html.indexOf('<table>') < 0) throw new Error('brief inline');
__t.S.inl = { w: 'brief', f: 'context', mode: 'preview', val: '- one\n- [ ] two' }; __t.render(); if (html.indexOf('<li>one</li>') < 0 || html.indexOf('type="checkbox"') < 0) throw new Error('brief md preview');
__t.S.inl = null;
console.log('INL-OK');
__t.S.taskId = 18; location.hash = '#task'; __t.fromHash();
if (html.indexOf('<code>tests/orders.test.ts</code>') < 0) throw new Error('agent md');
if (html.indexOf('href="https://github.com/podsterdev') >= 0) throw new Error('agent link clickable');
if (html.indexOf('README <span class="faint">(https://github.com/podsterdev') < 0) throw new Error('agent link as text');
__t.S.rv.round = 1; __t.S.tasks.find((t) => t.id === 18).stage = 'review'; location.hash = '#review'; __t.fromHash(); if (html.indexOf('<code>24px</code>') < 0) throw new Error('review notes md');
console.log('AMD-OK');
// Code view, delete, one list, drag markup, keys/theme
__t.S.palette = false; __t.S.modal = null; __t.S.drawer = null; __t.S.tasks.find((t) => t.id === 18).stage = 'review'; __t.S.notes[0].st = 'open';
__t.S.rv.view = 'code'; location.hash = '#review'; __t.fromHash(); if (html.indexOf('class="difft"') < 0 || html.indexOf('class="inote') < 0 || html.indexOf('data-act="note-add"') < 0) throw new Error('code view');
__t.S.rv.file = 'tests/orders.test.ts'; __t.render(); if (html.indexOf('adds an order') < 0) throw new Error('file switch');
__t.S.rv.view = 'preview'; __t.render(); if (html.indexOf('class="stagewrap"') < 0) throw new Error('preview back');
__t.S.delAsk = 'room'; location.hash = '#team'; __t.fromHash(); if (html.indexOf('recoverable copy for up to 7 days') < 0 || html.indexOf('data-act="del-yes" disabled') < 0) throw new Error('room delete');
__t.S.delText = 'Customer order tracker'; __t.render(); if (html.indexOf('data-act="del-yes" disabled') >= 0) throw new Error('delete enable');
__t.S.delAsk = 'account'; __t.S.delText = ''; location.hash = '#me'; __t.fromHash(); if (html.indexOf('delete my account') < 0 || html.indexOf('Appearance') < 0) throw new Error('account delete');
__t.S.delAsk = null; __t.S.roomGone = true; location.hash = '#rooms'; __t.fromHash(); if (html.indexOf('was deleted') < 0 || html.indexOf('href="#home"') >= 0 && html.indexOf('roomrow" href="#home"') >= 0) throw new Error('room gone'); __t.S.roomGone = false;
for (const r of ['all', 'k-all']) { location.hash = '#' + r; __t.fromHash(); if (html.indexOf('data-act="ev-go"') < 0) throw new Error(r); }
location.hash = '#home'; __t.fromHash(); if (html.indexOf('href="#all"') < 0) throw new Error('one list link');
__t.S.view = 'board'; location.hash = '#board'; __t.fromHash(); if (html.indexOf('draggable="true"') < 0 || html.indexOf('data-col="planned"') < 0) throw new Error('drag markup');
__t.S.modal = 'keys'; __t.render(); if (html.indexOf('Keyboard shortcuts') < 0 || html.indexOf('class="kb"') < 0) throw new Error('keys'); __t.S.modal = null;
console.log('SIX-OK');
__t.S.wl = { step: 'email', path: '', via: '' }; location.hash = '#welcome'; __t.fromHash(); for (const p of ['Continue with Google','Continue with GitHub','Continue with X','Email me a link','data-act="wl-oauth"']) if (html.indexOf(p) < 0) throw new Error('signin ' + p);
__t.S.wl.step = 'xemail'; __t.render(); if (html.indexOf('data-form="xemail"') < 0 || html.indexOf('didn\'t share an email') < 0) throw new Error('x email step');
location.hash = '#me'; __t.fromHash(); if (html.indexOf('Ways to sign in') < 0 || html.indexOf('data-act="login-on" data-k="github"') < 0 || html.indexOf('data-act="login-ask" data-k="google"') < 0) throw new Error('account logins');
__t.S.loginAsk = 'google'; __t.render(); if (html.indexOf('data-act="login-off" data-k="google"') < 0) throw new Error('login off'); __t.S.loginAsk = '';
for (const st of ['email','xemail','check']) { __t.S.wl.step = st; location.hash = '#welcome'; __t.fromHash(); if (html.indexOf('class="split"') < 0 || html.indexOf('split-art') < 0) throw new Error('split ' + st); } __t.S.wl.step = 'choose'; __t.render(); if (html.indexOf('class="split"') >= 0) throw new Error('choose not split');
__t.S.wl = { step: 'choose', path: '', via: 'google' }; __t.render(); if (html.indexOf('role="radiogroup"') < 0 || html.indexOf('Signed in with Google') < 0 || html.indexOf('Pick one to continue') < 0) throw new Error('choose page'); __t.S.wl.path = 'contrib'; __t.render(); if (html.indexOf('Pair my agent') < 0 || html.indexOf('aria-checked="true" data-act="wl-path" data-p="contrib"') < 0) throw new Error('choose contrib'); __t.S.wl.path = 'creator'; __t.render(); if (html.indexOf('Start a workroom') < 0) throw new Error('choose creator');
__t.S.fresh = { lead: true, created: true, plan: 'approved' }; location.hash = '#fresh'; __t.fromHash(); if (html.indexOf('data-act="fresh-assign" data-v="pick"') < 0) throw new Error('assign btn'); for (const v of ['pick','sam','building']) { __t.S.fresh.assign = v; __t.render(); } if (html.indexOf('is building') < 0) throw new Error('assign building'); __t.S.fresh.assign = 'pick'; __t.render(); if (html.indexOf('data-v="sam"') < 0 || html.indexOf('Plans only') < 0) throw new Error('assign pick');
location.hash = '#org'; __t.fromHash(); if (html.indexOf('data-act="org-edit"') < 0 || html.indexOf('podster.dev/bakeryonelm') < 0) throw new Error('org view'); __t.S.org.edit = true; __t.S.org.draft = { name: 'Elm Street Bakery', slug: 'elmstreet', site: '' }; __t.render(); if (html.indexOf('data-form="org-save"') < 0 || html.indexOf('keep working for 90 days') < 0) throw new Error('org edit'); __t.S.org.name = 'Elm Street Bakery'; __t.S.org.edit = false; __t.S.org.draft = null; location.hash = '#rooms'; __t.fromHash(); if (html.indexOf('Elm Street Bakery') < 0) throw new Error('org name rooms'); __t.S.org.delAsk = true; location.hash = '#org'; __t.fromHash(); if (html.indexOf('2 workrooms are still here') < 0) throw new Error('org del'); __t.S.org.delAsk = false; __t.S.org.name = 'Bakery on Elm'; __t.S.as = 'marco'; __t.render(); __t.S.as = 'elena'; location.hash = '#home'; __t.fromHash(); __t.S.userMenu = true; __t.render(); if (html.indexOf('href="#org"') < 0) throw new Error('org menu link'); __t.S.userMenu = false;
location.hash = '#org-new'; __t.fromHash(); if (html.indexOf('data-form="org-new"') < 0 || html.indexOf('Create organization') < 0) throw new Error('org new'); __t.S.teams.push('Rivera Labs'); __t.S.orgNew = { name: '', made: 'Rivera Labs' }; __t.render(); if (html.indexOf('Rivera Labs is ready') < 0) throw new Error('org made'); __t.S.start.org = 'personal'; location.hash = '#start'; __t.fromHash(); if (html.indexOf('data-act="st-org" data-v="Rivera Labs"') < 0 || html.indexOf('Only you own it') < 0) throw new Error('start org picker'); location.hash = '#rooms'; __t.fromHash(); if (html.indexOf('Create an organization') < 0 || html.indexOf('Rivera Labs') < 0 || html.indexOf('Personal') < 0) throw new Error('rooms orgs'); __t.S.teams = []; __t.S.start.org = 'team';
__t.S.rvPanel = true; location.hash = '#review'; __t.fromHash(); if (html.indexOf('review float') < 0 || html.indexOf('aria-label="Hide review panel"') < 0) throw new Error('rv panel shown'); __t.S.rvPanel = false; __t.render(); if (html.indexOf('review float full') < 0) throw new Error('rv panel hidden'); __t.S.rvPanel = true;
location.hash = '#review'; __t.fromHash(); if (html.indexOf('rvbtn donly" data-act="rv-panel" aria-expanded="true"') < 0 || html.indexOf('data-act="rv-mode" data-m="confirm"') < 0) throw new Error('rv header toggles panel'); __t.S.rvPanel = false; __t.render(); if (html.indexOf('aria-expanded="false" aria-controls="rv-side"') < 0) throw new Error('rv header closed'); __t.S.rvPanel = true;
location.hash = '#agent'; __t.fromHash(); if (html.indexOf('Message Sam') >= 0 || html.indexOf('data-act="discuss"') < 0) throw new Error('agent discuss'); __t.S.drawer = 19; __t.S.dtab = 'discussion'; __t.S.draft = '@Sam Rivera '; __t.render(); if (html.indexOf('Message Sam') >= 0) throw new Error('sheet message sam'); __t.S.drawer = null; __t.S.draft = '';
__t.S.inl = null; location.hash = '#brief'; __t.fromHash(); if (html.indexOf('Done means') < 0 || html.indexOf('data-f="bdone"') >= 0 || html.indexOf('>Goal<') < 0) throw new Error('brief one body'); __t.S.brief.context = ''; __t.render(); if (html.indexOf('start with an outline') < 0) throw new Error('brief empty');
location.hash = '#start'; __t.fromHash(); if (html.indexOf('data-act="st-addrole"') < 0 || html.indexOf('rolepick') >= 0) throw new Error('role add closed'); __t.S.start.pick = true; __t.render(); if (html.indexOf('data-act="st-pickrole" data-r="QA"') < 0 || html.indexOf('data-r="UI/UX designer"') < 0 || html.indexOf('data-r="System designer"') < 0 || html.indexOf('data-r="Code reviewer"') >= 0 || html.indexOf('st-custom') < 0) throw new Error('role pills'); __t.S.start.pick = false;
location.hash = '#start'; __t.fromHash(); if (html.indexOf('data-act-change="st-preset"') < 0 || html.indexOf('Coordinator access') < 0) throw new Error('role presets'); __t.S.start.pick = true; __t.render(); if (html.indexOf('UI/UX designer<span class="faint" style="font-size:12px">\\u00b7 Guest') < 0 && html.indexOf('UI/UX designer<span class="faint" style="font-size:12px">\u00b7 Guest') < 0) throw new Error('pill preset'); __t.S.start.pick = false;
__t.S.toast = '<img src=x onerror=1>'; __t.render(); if (html.indexOf('<img src=x') >= 0) throw new Error('toast not escaped'); __t.S.toast = ''; location.hash = '#start'; __t.fromHash(); __t.S.start.roles.push(['<b>x"y</b>', 'Your own role', 1, false, 'member']); __t.render(); if (html.indexOf('<b>x"y') >= 0) throw new Error('role name not escaped'); __t.S.start.roles.pop(); __t.render();
location.hash = '#start'; __t.fromHash(); __t.S.start.repoSrc = 'existing'; __t.render(); if (html.indexOf('data-act="gh-install"') < 0) throw new Error('gh install'); __t.S.start.gh.installed = true; __t.render(); if (html.indexOf('data-act="gh-pick" data-r="bakery-on-elm/orders-api"') < 0) throw new Error('gh list'); __t.S.start.gh.q = 'zzz'; __t.render(); if (html.indexOf('No repository matches') < 0) throw new Error('gh empty'); __t.S.start.gh = { installed: true, q: '', pick: 'bakery-on-elm/orders-api' }; __t.render(); if (html.indexOf('Turn on branch protection') < 0) throw new Error('gh pick'); __t.S.start.repoSrc = 'new'; __t.S.start.gh = { installed: false, q: '', pick: '' };
console.log('AUTH-OK');
process.exit(0);

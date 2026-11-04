import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { inflateSync } from 'node:zlib'

import { chromium, expect, test } from '@playwright/test'
import type { Browser, Frame, Page } from '@playwright/test'

import { PRIVACY_MASK_COLOR, createPrivacyPolicy } from '../../packages/flowproof/src/capture/projectPrivacy.js'
import { startProjectRecorder } from '../../packages/flowproof/src/capture/projectRecorder.js'
import type { CaptureBinding, ProjectRecorder, SealedCapture } from '../../packages/flowproof/src/capture/projectRecorder.js'
import { parseDemonstrationCapture } from '../../packages/flowproof/src/project/contracts.js'
import type { DemonstrationCapture } from '../../packages/flowproof/src/project/contracts.js'

// T022 (rendered-pixel half): seeded synthetic secrets are rendered in actual headed Chromium
// inside a controlled synthetic target frame, embedded cross-origin in a Studio-like page, and the
// recorder's retained PNGs are decoded and checked pixel by pixel. Every seeded surface is painted
// in one distinctive green; an unmasked control screenshot (kept only in memory) proves each seed
// really renders, and the retained images must contain no such pixel, no Studio pixel and a
// uniform mask over each seeded region. Byte-marker scans are only a supplementary check.
//
// This is S3 module evidence on synthetic frames, not a selected-project acceptance run: no
// project admission, offline runtime, Studio server or model is involved.

const STUDIO_PORT = 43_160
const TARGET_PORT = 43_161
const STUDIO_ORIGIN = `http://127.0.0.1:${STUDIO_PORT}`
const TARGET_ORIGIN = `http://localhost:${TARGET_PORT}`
const FRAME_BOX = { x: 44, y: 64, width: 800, height: 600 }

/** Synthetic seeds; assertion messages name them, never print captured content. */
const SEEDS = {
  studio: 'fpseedstudio7781',
  password: 'Zq8-fpseedpassword3391',
  prefill: 'fpseedprefill4411',
  textarea: 'fpseedtextarea5521',
  editable: 'fpseededitable6631',
  privateRegion: 'fpseedprivate7741',
  overflow: 'fpseedoverflow8851',
  marked: 'fpseedmarked9961',
  linkedImage: 'fpseedlinkedimage3344',
  inlineSvg: 'fpseedinlinesvg4488',
  pseudo: 'Zq8-CssGenerated-5599',
  option: 'fpseedoption1071',
  nested: 'fpseednested2281',
  decoy: 'fpseeddecoy5512',
  consoleBearer: 'fpseedconsole6653abcdef',
  networkQuery: 'fpseednetq7742',
  nextInput: 'fpseednextinput3301',
  mirror: 'Mirror-fpseedmirror4455',
  overlay: 'fpseedoverlay6612',
} as const

const GREEN = 'rgb(0, 170, 0)'
const STUDIO_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: rgb(255, 255, 0); font: 16px sans-serif; }
  #studio-secret { position: absolute; left: 10px; top: 8px; color: ${GREEN}; }
  #target { position: absolute; left: 40px; top: 60px; width: 800px; height: 600px; border: 4px solid rgb(255, 0, 0); }
  #decoy { position: absolute; left: 900px; top: 60px; width: 300px; height: 120px; border: 0; }
  #overlay { position: absolute; left: 120px; top: 120px; width: 200px; height: 40px; background: white; color: ${GREEN}; display: none; z-index: 5; }
  #tiny-overlay { position: absolute; left: 55px; top: 75px; width: 2px; height: 2px; overflow: hidden; background: ${GREEN}; display: none; pointer-events: none; z-index: 6; }
</style></head><body>
  <div id="studio-secret">STUDIO ${SEEDS.studio}</div>
  <iframe id="target" src="${TARGET_ORIGIN}/blank"></iframe>
  <iframe id="decoy" src="${TARGET_ORIGIN}/decoy"></iframe>
  <div id="overlay">${SEEDS.overlay}</div>
  <div id="tiny-overlay"></div>
</body></html>`

const TARGET_STYLE = `<style>
  body { margin: 0; padding: 6px; background: white; font: 15px/1.2 sans-serif; color: rgb(0, 0, 200); }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .secret { color: ${GREEN}; }
  input, textarea, select, #editor, .account-panel, section, iframe, canvas, button, ul, a, img, svg, .generated { display: block; margin: 0 0 4px; }
  input, textarea, select { color: ${GREEN}; font: 15px sans-serif; }
  #list { height: 48px; overflow: auto; margin-top: 0; }
  .account-panel { position: relative; height: 22px; width: 200px; }
  .account-panel .overflow { position: absolute; left: 320px; top: 0; }
  .generated::after { content: attr(data-secret); color: ${GREEN}; }
</style>`

const APP_HTML = `<!doctype html><html><head><meta charset="utf-8">${TARGET_STYLE}</head><body>
  <h1 data-testid="heading">Public board heading</h1>
  <input id="title" data-testid="title" aria-label="Task title">
  <input id="pw" type="password" aria-label="Password">
  <input id="apikey" name="api_token" value="${SEEDS.prefill}" aria-label="Token">
  <textarea id="notes" aria-label="Notes" rows="2">${SEEDS.textarea}</textarea>
  <div id="editor" contenteditable="true" class="secret">${SEEDS.editable}</div>
  <div class="account-panel"><span class="secret">${SEEDS.privateRegion}</span><span class="secret overflow">${SEEDS.overflow}</span></div>
  <section data-flowproof-private><span class="secret">${SEEDS.marked}</span></section>
  <img id="linked-image" src="/private.svg" alt="Synthetic private image">
  <svg id="inline-svg" width="240" height="26"><rect width="240" height="26" fill="${GREEN}"></rect><text x="2" y="18" fill="${GREEN}">${SEEDS.inlineSvg}</text></svg>
  <select id="filter" aria-label="Filter"><option value="all">${SEEDS.option} all</option><option value="done">done</option></select>
  <iframe id="nested" src="/nested" style="width: 240px; height: 26px; border: 0"></iframe>
  <canvas id="chart" width="240" height="26"></canvas>
  <button id="add" data-testid="add">Add task</button>
  <ul id="list" data-testid="list">${Array.from({ length: 10 }, (_, n) => `<li>Item ${n + 1}</li>`).join('')}</ul>
  <button id="route" data-testid="route">Show done</button>
  <input id="autosave" data-testid="autosave" aria-label="Autosave title">
  <script>
    const chart = document.getElementById('chart').getContext('2d');
    chart.fillStyle = '${GREEN}';
    chart.fillRect(0, 0, 240, 26);
    document.getElementById('add').addEventListener('click', () => {
      console.error('add failed Authorization: Bearer ${SEEDS.consoleBearer}');
      fetch('/missing.json?token=${SEEDS.networkQuery}').catch(() => undefined);
    });
    document.getElementById('route').addEventListener('click', () => history.pushState({}, '', '/app?view=done'));
    document.getElementById('autosave').addEventListener('input', (event) => {
      if (event.target.value === 'Go now') setTimeout(() => location.assign('/next'), 80);
    });
  </script>
</body></html>`

const NEXT_HTML = `<!doctype html><html><head><meta charset="utf-8">${TARGET_STYLE}</head><body>
  <h1>Next public page</h1>
  <input id="nextfield" value="${SEEDS.nextInput}" aria-label="Next field">
  <button id="confirm" data-testid="confirm">Confirm</button>
</body></html>`

const REFLECT_HTML = `<!doctype html><html><head><meta charset="utf-8">${TARGET_STYLE}</head><body>
  <h1>Reflection page</h1>
  <button id="ping" data-testid="ping">Ping</button>
  <input id="secret" type="password" aria-label="Secret">
  <input id="pin" type="password" name="pin" aria-label="PIN">
  <input id="pseudo-secret" type="password" aria-label="Pseudo secret">
  <p id="pin-echo"></p>
  <p id="generated" class="generated"></p>
  <p id="echo"></p>
  <button id="greet" class="greet">Greet</button>
  <canvas id="pad" width="300" height="80" style="background: rgb(230, 230, 230)"></canvas>
  <div id="rich" contenteditable="true">Rich text</div>
  <script>
    const secret = document.getElementById('secret');
    secret.addEventListener('input', () => {
      document.getElementById('echo').textContent = 'Hello ' + secret.value;
      document.getElementById('greet').textContent = 'Greet ' + secret.value;
    });
    document.getElementById('pin').addEventListener('input', (event) => {
      document.getElementById('pin-echo').textContent = 'Current value ' + event.target.value;
    });
    document.getElementById('pseudo-secret').addEventListener('input', (event) => {
      document.getElementById('generated').setAttribute('data-secret', event.target.value);
    });
  </script>
</body></html>`

const BACKGROUND_HTML = `<!doctype html><html><head><meta charset="utf-8">${TARGET_STYLE}</head><body>
  <h1>Background image</h1>
  <div id="background-private" style="width: 240px; height: 26px; background-image: url('/private.svg')"></div>
</body></html>`

const PAGES: Record<string, string> = {
  '/blank': '<!doctype html><title>blank</title>',
  '/decoy': `<!doctype html><body style="margin:0"><button id="decoy" style="width:280px;height:100px">Decoy ${SEEDS.decoy}</button></body>`,
  '/nested': `<!doctype html><body style="margin:0;color:${GREEN};font:15px sans-serif">${SEEDS.nested}</body>`,
  '/app': APP_HTML,
  '/next': NEXT_HTML,
  '/reflect': REFLECT_HTML,
  '/background': BACKGROUND_HTML,
}

function serve(host: string, port: number, route: (path: string) => { status: number; body: string; contentType?: string }): Promise<Server> {
  const server = createServer((request, response) => {
    const { status, body, contentType } = route(new URL(request.url ?? '/', 'http://local').pathname)
    response.writeHead(status, { 'content-type': contentType ?? 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(body)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}

const targetRoute = (path: string) => {
  if (path === '/private.svg') {
    return {
      status: 200,
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="26"><rect width="240" height="26" fill="${GREEN}"/><text x="2" y="18" fill="${GREEN}">${SEEDS.linkedImage}</text></svg>`,
    }
  }
  return PAGES[path] !== undefined ? { status: 200, body: PAGES[path] } : { status: 404, body: 'not found' }
}

// ---------------------------------------------------------------------------------------
// Minimal PNG decoding (8-bit RGB/RGBA, non-interlaced) for pixel assertions
// ---------------------------------------------------------------------------------------

interface Pixels {
  readonly width: number
  readonly height: number
  readonly rgba: Uint8Array
}

function decodePng(png: Buffer): Pixels {
  expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  const data: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const chunk = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      const [depth, color, , , interlace] = [chunk[8], chunk[9], chunk[10], chunk[11], chunk[12]]
      expect({ depth, interlace }).toEqual({ depth: 8, interlace: 0 })
      channels = color === 6 ? 4 : color === 2 ? 3 : 0
      expect(channels, `PNG color type ${color}`).toBeGreaterThan(0)
    } else if (type === 'IDAT') data.push(chunk)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  let previous = new Uint8Array(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const current = new Uint8Array(stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? current[x - channels]! : 0
      const b = previous[x]!
      const c = x >= channels ? previous[x - channels]! : 0
      const value = line[x]!
      let predictor = 0
      if (filter === 1) predictor = a
      else if (filter === 2) predictor = b
      else if (filter === 3) predictor = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      current[x] = (value + predictor) & 0xff
    }
    for (let x = 0; x < width; x += 1) {
      out.set([current[x * channels]!, current[x * channels + 1]!, current[x * channels + 2]!, channels === 4 ? current[x * channels + 3]! : 255], (y * width + x) * 4)
    }
    previous = current
  }
  return { width, height, rgba: out }
}

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
type Classifier = (r: number, g: number, b: number) => boolean

const isGreen: Classifier = (r, g, b) => r < 90 && g > 120 && b < 90
const isStudioRed: Classifier = (r, g, b) => r > 200 && g < 60 && b < 60
const isStudioYellow: Classifier = (r, g, b) => r > 200 && g > 200 && b < 60
const isPublicBlue: Classifier = (r, g, b) => b > 150 && r < 80 && g < 80
const MASK = [Number.parseInt(PRIVACY_MASK_COLOR.slice(1, 3), 16), Number.parseInt(PRIVACY_MASK_COLOR.slice(3, 5), 16), Number.parseInt(PRIVACY_MASK_COLOR.slice(5, 7), 16)]
const isMask: Classifier = (r, g, b) => r === MASK[0] && g === MASK[1] && b === MASK[2]

function count(pixels: Pixels, classify: Classifier, box: Box = { x: 0, y: 0, width: pixels.width, height: pixels.height }): { readonly hits: number; readonly total: number } {
  let hits = 0
  let total = 0
  const x0 = Math.max(0, Math.ceil(box.x))
  const y0 = Math.max(0, Math.ceil(box.y))
  const x1 = Math.min(pixels.width, Math.floor(box.x + box.width))
  const y1 = Math.min(pixels.height, Math.floor(box.y + box.height))
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = (y * pixels.width + x) * 4
      total += 1
      if (classify(pixels.rgba[index]!, pixels.rgba[index + 1]!, pixels.rgba[index + 2]!)) hits += 1
    }
  }
  return { hits, total }
}

const inset = (box: Box, by = 1.5): Box => ({ x: box.x + by, y: box.y + by, width: Math.max(0, box.width - 2 * by), height: Math.max(0, box.height - 2 * by) })

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

const BINDING: CaptureBinding = {
  run_id: '0e3d6a9c-1b2f-4c5d-9e8f-7a6b5c4d3e2f',
  project_id: '1f4e7b0d-2c3a-4d6e-8f9a-8b7c6d5e4f3a',
  baseline_commit: 'a'.repeat(40),
  configuration_id: '2a5f8c1e-3d4b-4e7f-a0b1-9c8d7e6f5a4b',
  configuration_digest: 'b'.repeat(64),
  target_origin: TARGET_ORIGIN,
  viewport: { width: 800, height: 600, device_scale_factor: 1 },
  build_sha256: 'c'.repeat(64),
}
const POLICY = createPrivacyPolicy({ privateSelectors: ['.account-panel'], admitSafeValues: true })

let servers: Server[] = []
let browser: Browser
let page: Page

test.beforeAll(async () => {
  servers = await Promise.all([
    serve('127.0.0.1', STUDIO_PORT, (path) => (path === '/' ? { status: 200, body: STUDIO_HTML } : { status: 404, body: '' })),
    serve('127.0.0.1', TARGET_PORT, targetRoute),
    serve('::1', TARGET_PORT, targetRoute),
  ])
  browser = await chromium.launch({ headless: false })
})

test.afterAll(async () => {
  await browser?.close()
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

test.beforeEach(async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  page = await context.newPage()
  await page.goto(`${STUDIO_ORIGIN}/`)
})

test.afterEach(async () => {
  await page.context().close()
})

async function targetFrame(): Promise<Frame> {
  const frame = await (await page.$('iframe#target'))?.contentFrame()
  if (!frame) throw new Error('target frame missing')
  await frame.waitForLoadState('load')
  return frame
}

const start = async (frame: Frame, entryPath: string): Promise<ProjectRecorder> => startProjectRecorder({ page, frame, binding: BINDING, entryPath, policy: POLICY })

/**
 * Test-driver pacing only: Playwright computes pointer coordinates for this out-of-process frame
 * itself, and a concurrent screenshot can make that computation land 64 px (the frame offset) off,
 * so a misdirected trusted click is retried. Human pointer input has no such step. Keyboard input
 * below still overlaps image production deliberately.
 */
async function pointer(recorder: ProjectRecorder, action: () => Promise<unknown>): Promise<void> {
  await recorder.session.imagesSettled()
  await action()
}

function images(sealed: SealedCapture): Array<{ readonly id: string; readonly sequence: { first: number; last: number } | null; readonly pixels: Pixels; readonly png: Buffer }> {
  return sealed.capture.observations.flatMap((observation) => {
    if (observation.type !== 'image' || observation.payload === null) return []
    const png = sealed.artifacts.get(observation.payload.artifact.artifact_id)
    if (!png) throw new Error('registered image bytes missing')
    return [{ id: observation.observation_id, sequence: observation.sequence_range, pixels: decodePng(png), png }]
  })
}

function expectNoSeedLeak(capture: DemonstrationCapture, artifacts: ReadonlyMap<string, Buffer>, allowed: readonly string[] = []): void {
  const report = JSON.stringify(capture)
  const leaked = Object.entries(SEEDS).filter(([name, value]) => !allowed.includes(name) && report.includes(value)).map(([name]) => name)
  expect(leaked, 'seeded values present in the staged report').toEqual([])
  // Supplementary only: a marker absent from PNG bytes says nothing about rendered pixels.
  for (const bytes of artifacts.values()) for (const value of Object.values(SEEDS)) expect(bytes.includes(Buffer.from(value))).toBe(false)
}

/** Frame-local CSS box: the same coordinate space as the retained target-only image. */
async function boxIn(frame: Frame, selector: string): Promise<Box> {
  return frame.locator(selector).first().evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
}

// ---------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------

test('retained target images mask every seeded secret surface before retention, pixel by pixel', async () => {
  const frame = await targetFrame()
  const recorder = await start(frame, '/app')
  expect(recorder.session.state).toBe('recording')
  // A sibling frame of the same target origin, loaded after instrumentation, is not the target.
  const decoy = await (await page.$('iframe#decoy'))?.contentFrame()
  await decoy?.goto(`${TARGET_ORIGIN}/decoy`)

  await pointer(recorder, () => frame.click('#title'))
  await page.keyboard.type('Buy milk')
  await pointer(recorder, () => frame.click('#pw'))
  await page.keyboard.insertText(SEEDS.password)
  await pointer(recorder, () => frame.click('#add'))

  // Positive control, kept in memory only: without masks, every seeded surface really renders green.
  const control = decodePng(await page.screenshot({ clip: FRAME_BOX }))
  const fullControl = decodePng(await page.screenshot())
  expect(count(fullControl, isStudioRed).hits, 'control: Studio border renders').toBeGreaterThan(100)
  expect(count(fullControl, isGreen, { x: 0, y: 0, width: 400, height: 40 }).hits, 'control: Studio secret renders').toBeGreaterThan(20)
  const seeded: Record<string, string> = {
    title: '#title',
    password: '#pw',
    prefill: '#apikey',
    textarea: '#notes',
    editable: '#editor',
    privateRegion: '.account-panel',
    overflow: '.account-panel .overflow',
    marked: 'section[data-flowproof-private]',
    linkedImage: '#linked-image',
    inlineSvg: '#inline-svg',
    option: '#filter',
    nested: '#nested',
    canvas: '#chart',
  }
  const boxes: Record<string, Box> = {}
  for (const [name, selector] of Object.entries(seeded)) {
    boxes[name] = await boxIn(frame, selector)
    expect(count(control, isGreen, boxes[name]).hits, `control: ${name} renders seeded green pixels`).toBeGreaterThan(8)
  }
  // Let the image for the Add click settle before the page state moves on.
  await expect.poll(() => recorder.session.snapshot().observations.filter((observation) => observation.type === 'image').length).toBeGreaterThanOrEqual(4)

  await frame.focus('#filter')
  await page.keyboard.press('ArrowDown')
  await pointer(recorder, () => frame.hover('#list'))
  await page.mouse.wheel(0, 90)
  await expect.poll(() => frame.locator('#list').evaluate((list) => list.scrollTop)).toBeGreaterThan(0)
  await pointer(recorder, () => frame.click('#route'))
  await expect.poll(() => frame.url()).toBe(`${TARGET_ORIGIN}/app?view=done`)

  // Activity in another frame of the target origin and in Studio itself is never collected.
  await pointer(recorder, () => page.mouse.click(1050, 110))
  await pointer(recorder, () => page.mouse.click(1000, 700))

  await pointer(recorder, () => frame.click('#autosave'))
  await page.keyboard.type('Go now')
  await frame.waitForURL(`${TARGET_ORIGIN}/next`)
  await pointer(recorder, () => frame.click('#confirm'))

  const sealed = await recorder.finish()
  const { capture } = sealed
  expect(parseDemonstrationCapture(capture).ok).toBe(true)
  expect(capture.state, JSON.stringify(capture.completeness)).toBe('ready')
  expect(capture.document_epoch).toBe(1)
  expect(capture.interactions.every((interaction) => interaction.frame_id === recorder.frameId)).toBe(true)

  const summary = capture.interactions.map((interaction) => {
    const action = interaction.action
    const detail = action.type === 'fill' ? action.value : action.type === 'select' ? action.value : action.type === 'navigate' ? action.path : action.type === 'scroll' ? action.target.kind : action.locators[0]
    return [interaction.document_epoch, action.type, detail]
  })
  expect(summary).toEqual([
    [0, 'click', { kind: 'test-id', value: 'title' }],
    [0, 'fill', { kind: 'safe', text: 'Buy milk' }],
    [0, 'click', { kind: 'css', selector: 'input#pw' }],
    [0, 'fill', { kind: 'redacted', reason: 'FIELD_SENSITIVE' }],
    [0, 'click', { kind: 'test-id', value: 'add' }],
    [0, 'select', { kind: 'safe', option: 'done' }],
    [0, 'scroll', 'element'],
    [0, 'click', { kind: 'test-id', value: 'route' }],
    [0, 'navigate', '/app?view=done'],
    [0, 'click', { kind: 'test-id', value: 'autosave' }],
    // The pending typed value is flushed in its own epoch before the new document's navigation.
    [0, 'fill', { kind: 'safe', text: 'Go now' }],
    [1, 'navigate', '/next'],
    [1, 'click', { kind: 'test-id', value: 'confirm' }],
  ])

  const consoleObservation = capture.observations.find((observation) => observation.type === 'console')
  expect(consoleObservation?.payload).toMatchObject({ level: 'error' })
  const network = capture.observations.find((observation) => observation.type === 'network-error')
  expect(network?.payload).toMatchObject({ method: 'GET', path: '/missing.json', status: 404, error_class: 'HTTP_ERROR' })
  expectNoSeedLeak(capture, sealed.artifacts)
  expect(JSON.stringify(capture)).not.toMatch(/Decoy|STUDIO/)

  const retained = images(sealed)
  expect(retained.length).toBeGreaterThanOrEqual(8)
  for (const image of retained) {
    expect({ width: image.pixels.width, height: image.pixels.height }).toEqual({ width: FRAME_BOX.width, height: FRAME_BOX.height })
    expect(count(image.pixels, isGreen).hits, `image ${image.id}: seeded green pixels`).toBe(0)
    expect(count(image.pixels, isStudioRed).hits, `image ${image.id}: Studio border pixels`).toBe(0)
    expect(count(image.pixels, isStudioYellow).hits, `image ${image.id}: Studio background pixels`).toBe(0)
    expect(count(image.pixels, isPublicBlue).hits, `image ${image.id}: public content is still visible`).toBeGreaterThan(150)
  }

  // The image taken for the Add click shares the control's state: each seeded region is masked.
  const addClick = capture.interactions[4]
  const addImage = retained.find((image) => addClick?.related_observation_ids.includes(image.id))
  expect(addImage, 'an image is associated with the Add click').toBeDefined()
  for (const [name, box] of Object.entries(boxes)) {
    const { hits, total } = count(addImage!.pixels, isMask, inset(box))
    expect(total, `${name}: region inside the target image`).toBeGreaterThan(0)
    expect(hits / total, `${name}: region uniformly masked`).toBeGreaterThan(0.98)
  }
})

test('rendered reflections, occluding Studio content and unsupported gestures are explicit, never retained', async () => {
  const frame = await targetFrame()
  const recorder = await start(frame, '/reflect')
  await expect.poll(() => recorder.session.status().artifactIds.length).toBe(1)

  // A Studio element covering the target makes a target-only image impossible.
  await page.evaluate(() => void (document.getElementById('overlay')!.style.display = 'block'))
  await pointer(recorder, () => frame.click('#ping', { position: { x: 5, y: 5 } }))
  await expect.poll(() => recorder.session.snapshot().observations.filter((observation) => observation.type === 'image').length).toBe(2)
  await page.evaluate(() => void (document.getElementById('overlay')!.style.display = 'none'))

  // A redacted typed value reflected into rendered text and an accessible name.
  await pointer(recorder, () => frame.click('#secret'))
  await page.keyboard.insertText(SEEDS.mirror)
  await pointer(recorder, () => frame.click('#greet'))

  await recorder.session.imagesSettled()
  const pad = await frame.locator('#pad').boundingBox()
  if (!pad) throw new Error('pad missing')
  await page.mouse.move(pad.x + 20, pad.y + 20)
  await page.mouse.down()
  await page.mouse.move(pad.x + 120, pad.y + 50, { steps: 5 })
  await page.mouse.up()
  await pointer(recorder, () => frame.click('#rich'))
  await page.keyboard.type('x')

  const sealed = await recorder.finish()
  const { capture } = sealed
  expect(parseDemonstrationCapture(capture).ok).toBe(true)
  expect(capture.state).toBe('unsupported')
  expect(capture.completeness?.reasons).toEqual(expect.arrayContaining(['IMAGE_SENSITIVE_TEXT', 'CANVAS_GESTURE', 'CONTENTEDITABLE_EDIT']))
  const imageReasons = capture.observations.filter((observation) => observation.type === 'image').map((observation) => observation.reason)
  expect(imageReasons).toContain('IMAGE_TARGET_OCCLUDED')
  expect(imageReasons).toContain('IMAGE_SENSITIVE_TEXT')
  const greet = capture.interactions.find((interaction) => interaction.action.type === 'click' && JSON.stringify(interaction.action).includes('greet'))
  expect(greet?.action).toEqual({ type: 'click', locators: [{ kind: 'css', selector: 'button#greet' }] })
  expectNoSeedLeak(capture, sealed.artifacts)
  for (const image of images(sealed)) expect(count(image.pixels, isGreen).hits).toBe(0)
})

test('a short refused input reflected into rendered text omits every affected PNG', async () => {
  const frame = await targetFrame()
  const recorder = await start(frame, '/reflect')
  await recorder.session.imagesSettled()
  await pointer(recorder, () => frame.click('#pin'))
  await page.keyboard.type('317')
  await pointer(recorder, () => frame.click('#ping'))
  const sealed = await recorder.finish()

  expect(sealed.capture.state).toBe('unsupported')
  expect(sealed.capture.completeness?.reasons).toContain('PRIVACY_REGISTRY_LIMIT')
  expect(sealed.capture.observations.filter((observation) => observation.type === 'image' && observation.availability === 'omitted').map((observation) => observation.reason)).toContain('IMAGE_TEXT_UNVERIFIED')
  expect(JSON.stringify({
    actions: sealed.capture.interactions.map((interaction) => interaction.action),
    errors: sealed.capture.observations.filter((observation) => observation.type !== 'image').map((observation) => observation.payload),
  })).not.toContain('317')
  expect(images(sealed).length).toBe(1) // Only the pre-input start image is retainable.
})

test('CSS-generated reflected private text is assessed before any screenshot is retained', async () => {
  const frame = await targetFrame()
  const recorder = await start(frame, '/reflect')
  await recorder.session.imagesSettled()
  await frame.locator('#pseudo-secret').focus()
  await page.keyboard.insertText(SEEDS.pseudo)

  const generated = await boxIn(frame, '#generated')
  const control = decodePng(await page.screenshot({ clip: FRAME_BOX }))
  expect(count(control, isGreen, generated).hits, 'control: CSS pseudo secret renders').toBeGreaterThan(8)
  const sealed = await recorder.finish()
  expect(sealed.capture.state).toBe('unsupported')
  expect(sealed.capture.completeness?.reasons).toContain('IMAGE_SENSITIVE_TEXT')
  expect(JSON.stringify({
    actions: sealed.capture.interactions.map((interaction) => interaction.action),
    observations: sealed.capture.observations.filter((observation) => observation.type !== 'image').map((observation) => observation.payload),
  })).not.toContain(SEEDS.pseudo)
  expect(images(sealed).length).toBe(1) // The pre-input image only.
})

test('uninspectable CSS background images make image evidence unavailable', async () => {
  const frame = await targetFrame()
  const recorder = await start(frame, '/background')
  await recorder.session.imagesSettled()

  const background = await boxIn(frame, '#background-private')
  const control = decodePng(await page.screenshot({ clip: FRAME_BOX }))
  expect(count(control, isGreen, background).hits, 'control: CSS background image renders').toBeGreaterThan(8)

  const sealed = await recorder.finish()
  expect(sealed.capture.state).toBe('unsupported')
  expect(sealed.capture.completeness?.reasons).toContain('IMAGE_TEXT_UNVERIFIED')
  expect(images(sealed).length).toBe(0)
})

test('a small Studio overlay between geometry samples cannot enter retained target PNGs', async () => {
  const frame = await targetFrame()
  await page.evaluate(() => void (document.getElementById('tiny-overlay')!.style.display = 'block'))
  const recorder = await start(frame, '/app')
  await recorder.session.imagesSettled()
  await pointer(recorder, () => frame.click('#add'))
  const sealed = await recorder.finish()

  expect(sealed.capture.observations.filter((observation) => observation.type === 'image').map((observation) => observation.reason)).toContain('IMAGE_TARGET_OCCLUDED')
  for (const image of images(sealed)) expect(count(image.pixels, isGreen).hits).toBe(0)
})

test('discard clears staged images and a re-recording starts a new capture with no carried state', async () => {
  const frame = await targetFrame()
  const first = await start(frame, '/app')
  await pointer(first, () => frame.click('#add'))
  const imageReasons = () => first.session.snapshot().observations.filter((observation) => observation.type === 'image').map((observation) => observation.reason)
  await expect.poll(() => first.session.status().artifactIds.length, { message: `image reasons: ${JSON.stringify(imageReasons())}` }).toBeGreaterThanOrEqual(2)
  const staged = first.session.status().artifactIds.map((id) => first.session.artifact(id))
  await first.discard()
  expect(first.session.state).toBe('discarded')
  expect(staged.every((bytes) => bytes !== undefined && bytes.every((byte) => byte === 0))).toBe(true)
  expect(first.session.snapshot()).toMatchObject({ interactions: [], observations: [], staged_bytes: 0, seal: null })
  await expect(first.finish()).rejects.toMatchObject({ code: 'CAPTURE_DISCARDED' })

  const second = await start(frame, '/app')
  await pointer(second, () => frame.click('#add'))
  const sealed = await second.finish()
  expect(sealed.capture.capture_id).not.toBe(first.session.captureId)
  expect(sealed.capture.state).toBe('ready')
  expect(sealed.capture.interactions.map((interaction) => [interaction.sequence, interaction.action.type])).toEqual([[1, 'click']])
  expect(sealed.capture.document_epoch).toBe(0)
})

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandInfo, On } from 'claude-code'
import { fitChips, frequent, kindOf, SAFE_NAME } from '../hooks/skills'
import { band, pane, panel } from './views'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

const COMMANDS: CommandInfo[] = [
  { name: 'clear', description: 'Clear conversation history', source: 'builtin' },
  { name: 'simplify', description: 'Review changed code for simplification', source: 'builtin' },
  { name: 'release-checklist', description: 'Run the release checklist', source: 'user' },
  {
    name: 'anthropic-skills:pdf',
    description: 'Read and fill PDFs',
    source: 'plugin',
    plugin: 'anthropic-skills',
  },
  {
    name: 'anthropic-skills:xlsx',
    description: 'Build spreadsheets',
    source: 'plugin',
    plugin: 'anthropic-skills',
  },
  { name: 'dock', description: 'Show all your skills', source: 'plugin', plugin: 'clawd-watch' },
]

/** The engine beneath the plugin: its commands, prompt box, panes and an empty band. */
function engine(on: On, store: Record<string, unknown> = {}, isPlaced = true, canRegister = true) {
  const filled: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, store)
  on('command.list', () => ({ value: COMMANDS }))
  on('command.register', ($, e) => {
    if (!canRegister) throw new Error('/dock is taken')
    return { value: { command: e.name } }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: 'for the Q3 report', cursor: 0 } }))
  on('prompt.fill', ($, e) => (filled.push(e.text), { isFilled: true }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.open', () => ({
    value: isPlaced
      ? { isPlaced: true as const }
      : { isPlaced: false as const, reason: 'this desktop app places no panes' },
  }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })

  return { filled, clock }
}

test('pinned and frequently used skills sit in the dock, and a click fills the prompt', async ($, on) => {
  const { filled } = engine(on, {
    pins: ['anthropic-skills:pdf'],
    uses: { simplify: [NOW - DAY, NOW - 2 * DAY], 'anthropic-skills:xlsx': [NOW - 20 * DAY] },
    knownSkills: ['simplify'],
  })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount(panel(surface))
    // The desktop app draws the section as a card whose title collapses it.
    const title =
      surface === 'terminal'
        ? await ui.find({ type: 'Text', text: 'Favourite skills' })
        : await ui.find({ key: 'card-favourite-skills' })
    expect(title).toBeDefined()
    expect((await ui.find({ key: 'dock-pin-anthropic-skills:pdf' }))?.props.label).toBe('★ pdf')
    expect((await ui.find({ key: 'dock-freq-simplify' }))?.props.label).toBe('simplify')
    expect(await ui.find({ key: 'dock-freq-clear' })).toBeUndefined()

    await ui.press({ key: 'dock-freq-simplify' })
    expect(filled.at(-1)).toBe('/simplify for the Q3 report')
    await ui.unmount()
  }
})

test('using a skill counts it, and pinning from the pane moves it to the front', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.skill.prompt({ skill: 'release-checklist', text: 'Run the checklist.' })
  await clock.advance(1)

  const dock = await $.ui.mount(band('terminal'))
  expect(await dock.find({ key: 'dock-freq-release-checklist' })).toBeDefined()

  // All skills turns the pane to every skill, with a way back.
  const skills = await $.ui.mount(pane('desktop'))
  await skills.press({ key: 'dock-all' })
  expect(await skills.find({ key: 'pane-back' })).toBeDefined()
  expect(await skills.find({ key: 'card-available-here' })).toBeDefined()
  expect(await skills.find({ key: 'used-use-release-checklist' })).toBeDefined()
  expect(await skills.find({ key: 'all-use-anthropic-skills:pdf' })).toBeDefined()
  await skills.press({ key: 'all-star-release-checklist' })

  expect(await dock.find({ key: 'dock-pin-release-checklist' })).toBeDefined()
  expect(await dock.find({ key: 'dock-freq-release-checklist' })).toBeUndefined()
  await skills.press({ key: 'pane-back' })
  expect(await skills.find({ key: 'card-favourite-skills' })).toBeDefined()
  await skills.unmount()
  await dock.unmount()
})

test('/ menu descriptions carry the pin and the count', async ($, on) => {
  engine(on, { pins: ['simplify'], uses: { 'release-checklist': [NOW - DAY] } })
  on('command.describe', ($, e) => ({ description: e.description, isHidden: false }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const base = {
    argumentHint: undefined,
    isHidden: false,
    immediate: false,
    provider: { plugin: 'engine', tier: 'core' as const },
  }
  const pinned = await $.command.describe({
    ...base,
    command: 'simplify',
    description: 'Review changed code',
  })
  const used = await $.command.describe({
    ...base,
    command: 'release-checklist',
    description: 'Run it',
  })

  expect(pinned.description).toBe('★ pinned · Review changed code')
  expect(used.description).toBe('↻ 1× in 30 days · Run it')
})

test('built-in commands only count as skills once they have been used as one', () => {
  expect(kindOf(COMMANDS[0]!, [])).toBeUndefined()
  expect(kindOf(COMMANDS[1]!, ['simplify'])).toEqual({ kind: 'builtin' })
  expect(kindOf(COMMANDS[2]!, [])).toEqual({ kind: 'mine' })
  expect(kindOf(COMMANDS[3]!, [])).toEqual({ kind: 'installed', origin: 'anthropic-skills' })
  expect(kindOf(COMMANDS[5]!, [])).toBeUndefined()
  expect(
    kindOf({ name: 'handoff', description: '', source: 'plugin', plugin: 'clawd-watch' }, []),
  ).toBeUndefined()

  const list = [
    { name: 'a', description: '', kind: 'mine' as const },
    { name: 'b', description: '', kind: 'mine' as const },
    { name: 'c', description: '', kind: 'mine' as const },
    { name: 'd', description: '', kind: 'mine' as const },
  ]
  const ranked = frequent(
    list,
    ['c'],
    { a: [NOW - 25 * DAY, NOW - 26 * DAY], b: [NOW], c: [NOW], d: [NOW - 40 * DAY] },
    NOW,
    5,
  )
  // More uses wins; uses older than 30 days don't count.
  expect(ranked.map(s => s.name)).toEqual(['a', 'b'])
})

test('where no pane can be placed, everything stays above the prompt', async ($, on) => {
  engine(on, { pins: ['simplify'], knownSkills: ['simplify'] }, false)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'clawd-watch-open' })
  expect(await ui.find({ key: 'dock-pin-simplify' })).toBeDefined()
  await ui.press({ key: 'dock-all' })
  expect(await ui.find({ type: 'Text', text: 'AVAILABLE HERE' })).toBeDefined()
  expect((await ui.find({ key: 'dock-all' }))?.props.label).toBe('Close')

  await ui.press({ key: 'dock-all' })
  expect(await ui.find({ type: 'Text', text: 'AVAILABLE HERE' })).toBeUndefined()
  await ui.unmount()
})

test(
  'set to terminal, the dock shows in the terminal only, with plain chips',
  { options: { show_in: 'terminal' } },
  async ($, on) => {
    engine(on, { pins: ['simplify'], knownSkills: ['simplify'] })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

    const desktop = await $.ui.mount(band('desktop'))
    expect(await desktop.find({ key: 'dock-pin-simplify' })).toBeUndefined()
    await desktop.unmount()

    const terminal = await $.ui.mount(band('terminal'))
    const chip = await terminal.find({ key: 'dock-pin-simplify' })
    expect(chip?.props.plain).toBe(true)
    expect(chip?.props.label).toBe('★ simplify')
    await terminal.unmount()
  },
)

test('pins still load when /dock cannot be registered', async ($, on) => {
  engine(on, { pins: ['simplify'], knownSkills: ['simplify'] }, true, false)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount(pane('desktop'))
  expect(await ui.find({ key: 'dock-pin-simplify' })).toBeDefined()
  await ui.unmount()
})

test('the dock keeps the chips that fit, paying for the separator once', () => {
  const chip = (name: string, isPinned: boolean) => ({ name, label: name, isPinned })
  const chips = [chip('aaaa', true), chip('bbbbbbbbbb', false), chip('cc', false)]

  // 4+2 for the pin, then 10+2+3 doesn't fit in the 9 left, but 2+2+3 does.
  expect(fitChips(chips, 15, 2).map(c => c.name)).toEqual(['aaaa', 'cc'])
  expect(fitChips(chips, 100, 2).map(c => c.name)).toEqual(['aaaa', 'bbbbbbbbbb', 'cc'])
  expect(fitChips(chips, 3, 2)).toEqual([])
})

test('the desktop shows every pin, with All skills beside the name', async ($, on) => {
  const many = ['simplify', 'release-checklist', 'anthropic-skills:pdf', 'anthropic-skills:xlsx']
  engine(on, { pins: many, knownSkills: ['simplify'] })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount(pane('desktop', 40))
  for (const name of many) expect(await ui.find({ key: `dock-pin-${name}` })).toBeDefined()
  expect((await ui.find({ key: 'dock-all' }))?.props.label).toBe('All skills (4) ›')
  await ui.unmount()
})

/** The pane, turned to every skill. */
async function skillsPane($: Engine) {
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'dock-all' })

  return ui
}

/** A home folder holding /release-checklist, installed from acme/skills, and a shell that moves files. */
function disk(on: On, moved: string[][]) {
  const folder = '/home/me/.claude/skills/release-checklist'
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.exists', ($, e) => ({ value: e.path === `${folder}/SKILL.md` }))
  on('fs.read', ($, e) => {
    if (e.path !== '/home/me/.agents/.skill-lock.json') throw new Error('missing')
    return { value: JSON.stringify({ skills: { 'release-checklist': { source: 'acme/skills' } } }) }
  })
  on('fs.write', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    moved.push([...e.argv])
    return {
      value: {
        exitCode: 0,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.toast', () => ({ value: undefined }))
}

test('the pane tags each skill by where it comes from, and filters and searches them', async ($, on) => {
  engine(on, { knownSkills: ['simplify'] })
  disk(on, [])
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const ui = await skillsPane($)

  expect(await ui.find({ key: 'skills-filter-all' })).toBeDefined()
  expect((await ui.find({ key: 'skills-filter-installed' }))?.props.label).toBe('Installed 3')
  expect(await ui.find({ type: 'Text', text: 'acme/skills' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Built-in' })).toBeDefined()

  await ui.press({ key: 'skills-filter-builtin' })
  expect(await ui.find({ key: 'all-row-simplify' })).toBeDefined()
  expect(await ui.find({ key: 'all-row-anthropic-skills:pdf' })).toBeUndefined()

  await ui.press({ key: 'skills-filter-all' })
  await ui.input({ key: 'skills-search', text: 'spread', kind: 'change' })
  expect(await ui.find({ key: 'all-row-anthropic-skills:xlsx' })).toBeDefined()
  expect(await ui.find({ key: 'all-row-simplify' })).toBeUndefined()
  await ui.unmount()
})

test('a plugin skill can be hidden and brought back', async ($, on) => {
  engine(on, { pins: ['anthropic-skills:pdf'] })
  disk(on, [])
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const ui = await skillsPane($)

  expect((await ui.find({ key: 'all-act-anthropic-skills:pdf' }))?.props.label).toBe('Hide')
  await ui.press({ key: 'all-act-anthropic-skills:pdf' })
  expect(await ui.find({ key: 'all-row-anthropic-skills:pdf' })).toBeUndefined()
  // Hiding a pin unpins it, so it leaves the dock too.
  expect(await ui.find({ key: 'pinned-row-anthropic-skills:pdf' })).toBeUndefined()

  await ui.press({ key: 'skills-filter-hidden' })
  await ui.press({ key: 'hidden-act-anthropic-skills:pdf' })
  await ui.press({ key: 'skills-filter-all' })
  expect(await ui.find({ key: 'all-row-anthropic-skills:pdf' })).toBeDefined()
  await ui.unmount()
})

test('one of your skills is removed only after a confirm, into a folder it can be restored from', async ($, on) => {
  const moved: string[][] = []
  engine(on)
  disk(on, moved)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const ui = await skillsPane($)

  expect((await ui.find({ key: 'all-act-release-checklist' }))?.props.label).toBe('Remove')
  await ui.press({ key: 'all-act-release-checklist' })
  expect(moved).toEqual([])
  await ui.press({ key: 'all-cancel-release-checklist' })
  expect(await ui.find({ key: 'all-remove-release-checklist' })).toBeUndefined()

  await ui.press({ key: 'all-act-release-checklist' })
  await ui.press({ key: 'all-remove-release-checklist' })
  expect(moved).toHaveLength(1)
  const [command, from, to] = moved[0]!
  expect([command, from]).toEqual(['mv', '/home/me/.claude/skills/release-checklist'])
  expect(to).toMatch(/^\/home\/me\/\.claude\/clawd-watch\/removed-skills\/release-checklist-\d{4}-/)
  expect(await ui.find({ key: 'all-row-release-checklist' })).toBeUndefined()
  await ui.unmount()
})

test('only plain skill names are ever looked up on disk', () => {
  for (const name of ['release-checklist', 'team:deploy', 'v1.2-notes']) {
    expect(SAFE_NAME.test(name)).toBe(true)
  }
  for (const name of ['..', '.hidden', 'a/b', 'team:..', '../etc', '']) {
    expect(SAFE_NAME.test(name)).toBe(false)
  }
})

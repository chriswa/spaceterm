/**
 * Central registry of all keyboard shortcuts, mouse interactions, and hidden
 * features. Drives the HelpModal (Cmd+?) so that every discoverable
 * interaction is documented in one place.
 *
 * Groups are rendered in array order — put the most essential stuff first so
 * new users see it without scrolling.
 */

export interface HelpEntry {
  /** Human-readable key combo, e.g. "Cmd + S" or "Click" */
  keys: string
  /** Short name for this action, shown in keycast overlay */
  name: string
  /** Optional additional context, shown only in the help modal */
  notes?: string
}

export interface HelpGroup {
  title: string
  /** Optional description rendered below the group title */
  description?: string
  entries: HelpEntry[]
}

const MAC_CMD = '\u2318'   // ⌘
const SHIFT   = '\u21E7'   // ⇧
const ENTER   = '\u23CE'   // ⏎
const UP      = '\u2191'   // ↑
const DOWN    = '\u2193'   // ↓
const LEFT    = '\u2190'   // ←
const RIGHT   = '\u2192'   // →

export const helpGroups: HelpGroup[] = [
  // ── Help ────────────────────────────────────────────────────────────
  {
    title: 'Help',
    entries: [
      { keys: `${MAC_CMD} ?`,            name: 'Help' },
    ],
  },

  // ── Getting Around ──────────────────────────────────────────────────
  {
    title: 'Getting Around',
    entries: [
      { keys: 'Drag canvas',             name: 'Pan the canvas' },
      { keys: 'Pinch / Scroll',          name: 'Zoom in and out' },
      { keys: 'Middle-mouse drag',       name: 'Pan from anywhere', notes: 'Even over nodes' },
      { keys: 'Double-click canvas',     name: 'Fit all nodes in view' },
      { keys: 'Click a node',            name: 'Focus the node' },
      { keys: `${MAC_CMD} ${UP}`,        name: 'Select parent node', notes: 'From root, fit all' },
      { keys: `${MAC_CMD} ${DOWN}`,      name: 'Jump to unattended Claude' },
      { keys: `${MAC_CMD} ${LEFT} / ${RIGHT}`, name: 'Cycle Claude surfaces', notes: 'In toolbar order' },
      { keys: `${MAC_CMD} [  /  ]`,      name: 'Camera history back / forward' },
      { keys: 'Escape',                   name: 'Dismiss', notes: 'Close modals, cancel reparent, or stop TTS' },
    ],
  },

  // ── Creating Nodes ──────────────────────────────────────────────────
  {
    title: 'Creating Nodes',
    description: 'You can also use the + button in any node\u2019s title bar to create a child node.',
    entries: [
      { keys: `${MAC_CMD} T`,            name: 'New terminal', notes: 'From markdown parent, sends its content as input' },
      { keys: `${MAC_CMD} E`,            name: 'New Claude surface' },
      { keys: `${MAC_CMD} M`,            name: 'New markdown note' },
      { keys: `${MAC_CMD} Click edge`,   name: 'Split an edge', notes: 'Insert a new node between parent and child' },
    ],
  },

  // ── Managing Nodes ──────────────────────────────────────────────────
  {
    title: 'Managing Nodes',
    entries: [
      { keys: `${MAC_CMD} W`,            name: 'Archive node' },
      { keys: `${MAC_CMD} Z`,            name: 'Undo last archive', notes: 'Buggy!' },
      { keys: `${MAC_CMD} D`,            name: 'Fork Claude surface' },
      { keys: 'Drag a node',             name: 'Move node and children' },
      { keys: `${MAC_CMD} Drag`,         name: 'Move node only', notes: 'Children stay put' },
    ],
  },

  // ── Search & Find ───────────────────────────────────────────────────
  {
    title: 'Search & Find',
    entries: [
      { keys: `${MAC_CMD} S  /  ${MAC_CMD} K`, name: 'Node search' },
      { keys: `${MAC_CMD} F`,            name: 'Find in terminal' },
      { keys: `${MAC_CMD} P`,            name: "Jump to Claude's plan", notes: 'Also happens automatically on focus' },
    ],
  },

  // ── Click & Interact ───────────────────────────────────────────────
  {
    title: 'Click & Interact',
    entries: [
      { keys: `${MAC_CMD} Click node`,   name: 'Quick-actions toolbar', notes: 'Color, fork, archive, add child, etc.' },
      { keys: 'Click terminal title',    name: 'Rename terminal', notes: 'When focused' },
      { keys: `${MAC_CMD} Click edge`,   name: 'Insert node on edge' },
      { keys: 'Click without Cmd on edge', name: 'Hint to hold Cmd' },
      { keys: `${MAC_CMD} Click link`,   name: 'Open URL in browser' },
    ],
  },

  // ── Node Relationships & Inheritance ────────────────────────────────
  {
    title: 'Node Relationships',
    description: 'Special things happen depending on the structure of your tree.',
    entries: [
      { keys: 'Terminal from Markdown',   name: 'Markdown \u2192 Terminal', notes: 'Heading becomes terminal name; body becomes initial command input' },
      { keys: 'Claude from Markdown',     name: 'Markdown \u2192 Claude', notes: 'All ancestor markdown & file paths are gathered as context for the system prompt' },
      { keys: 'Claude from any ancestor', name: 'Ancestor context', notes: 'Walks the full ancestor chain \u2014 every non-file-backed markdown and every file path is included' },
      { keys: 'Markdown under File',      name: 'File-backed markdown', notes: 'Content is read from disk and live-watched for changes' },
      { keys: 'File path change',         name: 'Auto re-watch', notes: 'All file-backed markdown children automatically re-watch the new file' },
      { keys: 'CWD inheritance',          name: 'CWD inheritance', notes: 'New terminals inherit working directory from the nearest ancestor terminal or directory' },
      { keys: 'Color inheritance',        name: 'Color inheritance', notes: 'Nodes inherit their color from the nearest ancestor with a color set' },
      { keys: 'Archive a node',           name: 'Reparent children', notes: 'Children are reparented to the archived node\u2019s parent (grandparent)' },
      { keys: 'Unarchive Claude surface', name: 'Resume session', notes: 'Automatically resumes the most recent session in that surface' },
    ],
  },

  // ── Markdown Notes ──────────────────────────────────────────────────
  {
    title: 'Markdown Notes',
    entries: [
      { keys: 'Click when focused',      name: 'Enter edit mode' },
      { keys: 'Drag bottom-right corner', name: 'Resize / set max width' },
      { keys: 'Escape',                   name: 'Exit edit mode' },
      { keys: '"Ship It" button',         name: 'Ship It', notes: 'Paste markdown content into parent terminal' },
    ],
  },

  // ── Directory & File Cards ─────────────────────────────────────────
  {
    title: 'Directory & File Cards',
    entries: [
      { keys: 'Click path when focused',  name: 'Edit path' },
      { keys: 'Git status bar',           name: 'Git status', notes: 'Shows branch, ahead/behind, staged/unstaged counts' },
      { keys: 'Click fetch age',          name: 'Git fetch' },
    ],
  },

  // ── Audio & Speech ──────────────────────────────────────────────────
  {
    title: 'Audio & Speech',
    entries: [
      { keys: `${MAC_CMD} ${SHIFT} S`,   name: 'Read aloud / stop TTS' },
    ],
  },

  // ── Toolbar (bottom bar) ───────────────────────────────────────────
  {
    title: 'Toolbar',
    entries: [
      { keys: 'Click a crab icon',        name: 'Jump to Claude surface' },
      { keys: 'Drag crab icons',          name: 'Reorder Claude surfaces' },
    ],
  },
]

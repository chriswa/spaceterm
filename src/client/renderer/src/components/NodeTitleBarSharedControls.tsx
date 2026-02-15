import { useEffect, useRef, useState } from 'react'
import { COLOR_PRESETS } from '../lib/color-presets'
import type { ColorPreset } from '../lib/color-presets'
import type { ArchivedNode } from '../../../../shared/state'
import { ArchivePanel } from './ArchivePanel'

interface NodeTitleBarSharedControlsProps {
  id: string
  preset?: ColorPreset
  archivedChildren: ArchivedNode[]
  onClose: (id: string) => void
  onColorChange: (id: string, color: string) => void
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
}

export function NodeTitleBarSharedControls({ id, preset, archivedChildren, onClose, onColorChange, onUnarchive, onArchiveDelete }: NodeTitleBarSharedControlsProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const archiveBtnRef = useRef<HTMLButtonElement>(null)

  // Close color picker on outside click
  useEffect(() => {
    if (!pickerOpen) return
    const handleClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [pickerOpen])

  // Close archive panel when archives become empty
  useEffect(() => {
    if (archivedChildren.length === 0) {
      setArchiveOpen(false)
    }
  }, [archivedChildren.length])

  return (
    <div className="node-titlebar__actions">
      <div style={{ position: 'relative' }} ref={pickerRef}>
        <button
          className="node-titlebar__color-btn"
          title="Header color"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => {
            e.stopPropagation()
            setPickerOpen((prev) => !prev)
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          &#9679;
        </button>
        {pickerOpen && (
          <div className="node-titlebar__color-picker" onMouseDown={(e) => e.stopPropagation()}>
            {COLOR_PRESETS.map((p) => (
              <button
                key={p.id}
                className="node-titlebar__color-swatch"
                style={{ backgroundColor: p.titleBarBg }}
                onClick={(e) => {
                  e.stopPropagation()
                  onColorChange(id, p.id)
                  setPickerOpen(false)
                }}
              />
            ))}
          </div>
        )}
      </div>
      {archivedChildren.length > 0 && (
        <>
          <button
            ref={archiveBtnRef}
            className="node-titlebar__archive-btn"
            title="Archived children"
            style={preset ? { color: preset.titleBarFg } : undefined}
            onClick={(e) => {
              e.stopPropagation()
              setArchiveOpen((prev) => !prev)
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {archivedChildren.length}
          </button>
          {archiveOpen && (
            <ArchivePanel
              parentId={id}
              archives={archivedChildren}
              anchorRef={archiveBtnRef}
              onUnarchive={onUnarchive}
              onArchiveDelete={onArchiveDelete}
              onClose={() => setArchiveOpen(false)}
            />
          )}
        </>
      )}
      <button
        className="node-titlebar__close"
        style={preset ? { color: preset.titleBarFg } : undefined}
        onClick={(e) => { e.stopPropagation(); onClose(id) }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        &times;
      </button>
    </div>
  )
}

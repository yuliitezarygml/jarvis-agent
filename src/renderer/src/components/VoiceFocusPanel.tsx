import { useEffect, useRef, useState } from 'react'
import { Mic, X } from 'lucide-react'
import type { VoiceFocusStatus } from '@shared/voice-focus'
import { api, IPC } from '../api'
import { useApp, useT } from '../store'

export function VoiceFocusPanel({ compact = false }: { compact?: boolean }) {
  const { t } = useT()
  const enabled = useApp((s) => s.settings.voiceFocusEnabled)
  const patch = useApp((s) => s.patchSettings)
  const [status, setStatus] = useState<VoiceFocusStatus>({ enabled, profile: false, state: 'off', seconds: 0 })
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [removeConfirm, setRemoveConfirm] = useState(false)
  const active = useRef(false)
  const setup = useRef(false)
  useEffect(() => {
    let updated = false, alive = true
    const off = api.on(IPC.voiceFocusChanged, (value: VoiceFocusStatus) => {
      updated = true
      if (value.state === 'loading' || value.state === 'error' || (value.profile && value.state === 'ready')) active.current = false
      setStatus(value)
    })
    void api.invoke(IPC.voiceFocusGet).then((value) => { if (alive && !updated && value) setStatus(value) })
    return () => {
      alive = false; off()
      if (active.current) void api.invoke(IPC.voiceFocusCancel)
      if (setup.current) void api.invoke(IPC.voiceFocusPrepare, false)
    }
  }, [])
  const recording = status.state === 'recording'
  const busy = pending || recording || status.state === 'loading'
  async function record() {
    setPending(true); setError(''); active.current = true; setup.current = true
    try { setStatus(await api.invoke(IPC.voiceFocusRecord)) }
    catch { active.current = false; setError('models') }
    finally { setPending(false) }
  }
  async function cancel() {
    active.current = false; setPending(false)
    setStatus(await api.invoke(IPC.voiceFocusCancel))
  }
  function close() {
    if (pending || recording) void cancel()
    setup.current = false; void api.invoke(IPC.voiceFocusPrepare, false)
    setOpen(false); setRemoveConfirm(false)
  }
  async function toggle() {
    setError('')
    try { await patch({ voiceFocusEnabled: !enabled }) }
    catch { setError('filter') }
  }
  const content = <>
    <div className="voice-focus-heading"><b>{t('focus.title')}</b>{compact && <button className="icon-btn" title={t('focus.close')} onClick={close}><X size={17} /></button>}</div>
    <p>{t('focus.hint')}</p>
    {status.profile && !recording && <p className={status.state === 'ready' ? 'focus-good' : ''}>{status.state === 'ready' ? t('focus.ready') : t(enabled ? 'focus.on' : 'focus.off')}</p>}
    <blockquote>{t('focus.prompt')}</blockquote>
    {recording && <div role="status"><b>{t('focus.recording', { seconds: String(status.seconds) })}</b><progress max={10} value={status.seconds} /></div>}
    {(pending || status.state === 'loading') && <p role="status">{t('focus.preparing')}</p>}
    {(error || status.error) && <p className="focus-error" role="alert">{t('focus.error.' + (error || status.error))}</p>}
    <div className="voice-focus-actions">
      <button className="btn primary" disabled={busy} onClick={() => void record()}><Mic size={15} />{t('focus.record')}</button>
      {(pending || recording) && <button className="btn" onClick={() => void cancel()}>{t('focus.cancel')}</button>}
      {status.profile && !busy && <button className="btn" onClick={() => void toggle()}>{t(enabled ? 'focus.disable' : 'focus.enable')}</button>}
      {status.profile && !busy && <button className="btn" onClick={() => setRemoveConfirm(true)}>{t('focus.remove')}</button>}
    </div>
    {removeConfirm && <div className="voice-focus-actions"><span>{t('focus.deleteConfirm')}</span><button className="btn" onClick={async () => { setStatus(await api.invoke(IPC.voiceFocusRemove)); setRemoveConfirm(false) }}>{t('focus.remove')}</button><button className="btn" onClick={() => setRemoveConfirm(false)}>{t('focus.cancel')}</button></div>}
  </>
  if (!compact) return <section className="voice-focus-panel">{content}</section>
  return <>
    <button className={'chip ' + (status.state === 'ready' ? 'ok' : status.state === 'error' ? 'bad' : '')} onClick={() => { setup.current = true; setOpen(true); void api.invoke(IPC.voiceFocusPrepare, true).catch(() => setError('microphone')) }}><Mic size={12} />{t(status.profile ? enabled ? 'focus.on' : 'focus.off' : 'focus.setup')}</button>
    {open && <div className="voice-focus-backdrop"><section className="glass voice-focus-panel voice-focus-dialog" role="dialog" aria-modal="true" aria-label={t('focus.title')}>{content}</section></div>}
  </>
}

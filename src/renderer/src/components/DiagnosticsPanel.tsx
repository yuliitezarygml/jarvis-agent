import { useEffect, useState, type ReactNode } from 'react'
import type { DiagnosticsSnapshot } from '@shared/types'
import { api, IPC } from '../api'
import { useApp, useT } from '../store'

export function DiagnosticsPanel() {
  const { t } = useT()
  const serverUrl = useApp((state) => state.settings.ttsServerUrl)
  const [data, setData] = useState<DiagnosticsSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const read = () => api.invoke(IPC.diagnosticsGet).then((value: DiagnosticsSnapshot) => { if (active && value) setData(value) }).catch(() => {})
    void read()
    const off = api.on(IPC.diagnosticsChanged, (value: DiagnosticsSnapshot) => { if (active) setData(value) })
    const timer = window.setInterval(read, 3000)
    setBusy(true)
    setError('')
    void api.invoke(IPC.diagnosticsRefresh)
      .then((value: DiagnosticsSnapshot) => { if (active && value) setData(value) })
      .catch(() => { if (active) setError('diag.loadError') })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false; off(); clearInterval(timer) }
  }, [serverUrl])

  const refresh = async () => {
    setBusy(true)
    setError('')
    try {
      const value = await api.invoke(IPC.diagnosticsRefresh)
      if (value) setData(value)
    } catch {
      setError('diag.loadError')
    } finally {
      setBusy(false)
    }
  }
  const time = (value: number) => new Date(value).toLocaleString()
  const row = (label: string, value: ReactNode, hint?: string) => (
    <div className="row">
      <div className="lbl"><b>{label}</b>{hint && <small>{hint}</small>}</div>
      <div className="ctl" style={{ flexWrap: 'wrap', overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  )
  const badge = (text: string, ok?: boolean) => <span className={'chip' + (ok === undefined ? '' : ok ? ' ok' : ' bad')}><span className="dot" />{text}</span>
  let address = ''
  try { const url = new URL(serverUrl); address = `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '') } catch {}

  return (
    <section className="sgroup">
      <div className="sbody glass">
        {row(t('diag.microphone'), badge(t('diag.mic.' + (data?.microphone.state ?? 'unknown')), data?.microphone.state === 'ready' ? true : data?.microphone.state === 'error' ? false : undefined), data?.microphone.error)}
        {row(t('diag.speech'), badge(t('diag.speech.' + (data?.speech.state ?? 'loading')), data?.speech.state === 'ready' ? true : data?.speech.state === 'error' || data?.speech.state === 'missing-models' ? false : undefined), data?.speech.missingModels.length ? t('diag.missing') + ': ' + data.speech.missingModels.join(', ') : undefined)}
        {row(t('diag.recognizer'), data ? t(data.speech.asrLoaded ? 'diag.loaded' : 'diag.idle') : '…')}
        {row(t('diag.server'), badge(t(data?.server ? data.server.ok ? 'diag.available' : 'diag.unavailable' : 'diag.unchecked'), data?.server?.ok), address || t('diag.invalidUrl'))}
        {data?.server?.ok && row(t('diag.serverVoice'), [data.server.model, data.server.voice].filter(Boolean).join(' · ') || '—', data.server.languages?.join(', '))}
        {data?.server && row(t('diag.responseTime'), `${data.server.ms} ${t('diag.ms')}`, time(data.server.checkedAt))}
        {data?.server?.error && row(t('diag.serverError'), data.server.error)}
        {row(t('diag.synthesis'), data?.synthesis ? <>{badge(t(data.synthesis.ok ? 'diag.success' : 'diag.failed'), data.synthesis.ok)} {data.synthesis.ms} {t('diag.ms')}</> : t('diag.noSynthesis'), data?.synthesis ? time(data.synthesis.at) : undefined)}
        {row(t('diag.voiceMode'), data ? `${t('voice.mode.' + data.voiceMode)} · ${t(data.voiceEnabled ? 'diag.enabled' : 'diag.disabled')}` : '…')}
        {row(t('diag.lastError'), data?.lastError ? <span style={{ color: 'var(--text-2)' }}>{data.lastError.message}</span> : t('diag.noErrors'), data?.lastError ? `${t('diag.source.' + data.lastError.source)} · ${time(data.lastError.at)}` : undefined)}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', flexWrap: 'wrap' }}>
          <button className="btn sm" disabled={busy} onClick={() => void refresh()}>{t(busy ? 'diag.checking' : 'diag.refresh')}</button>
          {error && <span role="alert">{t(error)}</span>}
        </div>
      </div>
    </section>
  )
}

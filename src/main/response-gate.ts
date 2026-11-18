/** SSE parts are admitted by their assistant message and parent user message, not by session alone. */
export class ResponseGate {
  private parent = ''
  private blocked = new Set<string>()
  private messages = new Set<string>()
  active = false
  get hasParent() { return !!this.parent }
  get hasOutput() { return this.messages.size > 0 }

  begin() {
    this.pause()
    this.parent = ''
    this.active = true
  }

  reset() {
    this.pause()
    this.parent = ''
  }

  pause() {
    if (this.parent) this.blocked.add(this.parent)
    if (this.blocked.size > 128) this.blocked.delete(this.blocked.values().next().value!)
    this.messages.clear()
    this.active = false
  }

  blockParent(id: string) {
    this.blocked.add(id)
    if (this.blocked.size > 128) this.blocked.delete(this.blocked.values().next().value!)
  }

  message(info: { id?: string; role?: string; parentID?: string }) {
    if (!this.active || !info.id) return false
    if (info.role === 'user') {
      if (!this.parent && !this.blocked.has(info.id)) this.parent = info.id
      return false
    }
    if (info.role !== 'assistant' || !info.parentID || this.blocked.has(info.parentID)) return false
    if (this.parent && this.parent !== info.parentID) return false
    this.parent = info.parentID
    this.messages.add(info.id)
    return true
  }

  part(messageID: string) { return this.active && this.messages.has(messageID) }
}

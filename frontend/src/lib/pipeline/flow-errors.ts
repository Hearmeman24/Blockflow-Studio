/** Thrown by `saveActiveFlow()` when the tab has no flow name yet; the caller
 * asks for one (Save As). Any other failure is a real error. */
export class FlowNameRequiredError extends Error {
  constructor() {
    super('Flow name is required')
    this.name = 'FlowNameRequiredError'
  }
}

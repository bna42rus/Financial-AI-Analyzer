/** Operational error shared by the assistant and the independent workflow core. */
export class AssistantError extends TypeError {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

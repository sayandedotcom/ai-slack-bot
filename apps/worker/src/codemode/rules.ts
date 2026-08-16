/**
 * The rules half of the `run_code` tool description.
 *
 * Its own module because BOTH chassis need it: `codemode/tool.ts` builds the
 * legacy tool, and `run/agent.ts` builds the Think one. Keeping it here rather
 * than exporting it from `tool.ts` preserves that module's export-surface
 * guard (`test/codemode-integration.test.ts` asserts the exact list, so a new
 * export there is a deliberate decision, not a side effect), and it outlives
 * the cutover that deletes `makeRunCodeTool`.
 *
 * `{{maxCodeChars}}` is substituted BEFORE `{{types}}` at every call site, so
 * nothing inside the generated declarations can be read as a placeholder.
 */
export const RULES = `You have one tool. Write JavaScript that calls the capabilities below.

- Write ONE async arrow function. It is the whole program.
- The program must be at most {{maxCodeChars}} characters. A longer one is
  refused before anything runs.
- The declarations are TypeScript, but you are writing JAVASCRIPT. No type
  annotations, no interfaces, no imports.
- Return the final, compact result. Filter and join in code rather than
  returning everything and reasoning over it afterwards — that is the entire
  point of running code instead of calling tools one at a time.
- Use console.log sparingly, for progress worth reading.
- Call namespaces directly: slack.thread({}), memory.recall({...}).
- Catch only errors you can genuinely recover from. An uncaught error comes
  back to you with a code you can act on; a swallowed one does not.
- There is no network. fetch exists but every call is refused. Do not probe
  for hidden variables, globals, or credentials — there are none, and the
  attempt is recorded.
- Do not assume a capability that is not declared below. If you need one that
  does not exist, say so in your answer instead of inventing it.

Errors come back as "code: message". The code is stable; read it and adapt.

Available capabilities:

{{types}}`;

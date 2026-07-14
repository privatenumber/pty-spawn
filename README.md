# pty-spawn

Spawn a PTY process and `await` it like a promise. Built on [`node-pty`](https://github.com/microsoft/node-pty).

## Install

```sh
npm install pty-spawn
```

## Quick start

```ts
import { spawn, waitFor } from 'pty-spawn'

const subprocess = spawn('node', ['server.js'])

// Wait for specific output
await waitFor(subprocess, output => output.includes('Listening on port 3000'))

// Interact
subprocess.stdin.write('quit\n')

// Await final result
const result = await subprocess
console.log(result.output)
```

## Why?

`node-pty` gives you low-level event wiring. `pty-spawn` wraps it into a single awaitable object:

| Without `pty-spawn` | With `pty-spawn` |
| --- | --- |
| Wire up promise + event cleanup | `await subprocess` |
| Buffer output + poll + handle exit/timeout | `waitFor(subprocess, predicate)` |
| Abort/exit race conditions | Late abort never overrides a clean exit |
| Manual output accumulation loop | `subprocess.output` (live string) |

## API

### `spawn(file, args?, options?)`

Spawns a PTY process. Returns a [`Subprocess`](#subprocess).

```ts
const subprocess = spawn('node', ['server.js'], { timeout: 5000 })

// Without args
const subprocess = spawn('bash', { window: { cols: 120 } })
```

#### Options

All [`node-pty` options](https://github.com/microsoft/node-pty) are supported, plus:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `window` | `{ cols?, rows? }` | — | PTY window size |
| `timeout` | `number` | `0` (disabled) | Auto-abort after _N_ ms |
| `signal` | `AbortSignal` | — | Abort control |
| `reject` | `boolean` | `true` | Reject on non-zero exit, signal, or abort. When `false`, always resolves |

### Subprocess

A `Promise<Result>` with control properties attached.

#### Properties

| Property | Type | Description |
| --- | --- | --- |
| `pid` | `number` | Process ID |
| `output` | `string` | Accumulated output (live — grows as the process writes) |

#### `stdin.write(data)`

Write to the process stdin. Safe to call after exit.

```ts
subprocess.stdin.write('hello\n')
```

#### `kill(signal?, options?)`

Terminate the process and wait for exit.

```ts
await subprocess.kill()
await subprocess.kill('SIGTERM')
await subprocess.kill('SIGTERM', { forceKill: 3000 })
await subprocess.kill({ forceKill: 3000 })
```

`forceKill` escalates to `SIGKILL` after the given milliseconds if the process traps the initial signal. Safe to call after exit.

#### `resize(cols, rows)`

Resize the PTY window. Safe to call after exit.

#### Async iteration

The subprocess itself is `AsyncIterable<string>` — stream output chunks in real time:

```ts
for await (const chunk of subprocess) {
    process.stdout.write(chunk)
}
```

#### Async disposal

Supports [`await using`](https://github.com/tc39/proposal-explicit-resource-management) for automatic cleanup:

```ts
{
    await using subprocess = spawn('node', ['server.js'])
    // killed when scope exits
}
```

### Result

`await subprocess` resolves only after pending terminal output has been delivered, so
`result.output` is complete when the promise settles:

| Property | Type | Description |
| --- | --- | --- |
| `output` | `string` | All terminal output |
| `exitCode` | `number` | Process exit code |
| `signalName` | `string?` | Signal name if terminated (e.g. `'SIGTERM'`) |
| `file` | `string` | Spawned file path |
| `args` | `string[]` | Arguments passed |
| `durationMs` | `number` | Wall-clock duration in ms |

> [!NOTE]
> PTYs combine stdout and stderr into a single stream. `output` contains everything the process wrote to the terminal.

### SubprocessError

Non-zero exit or signal termination rejects with `SubprocessError`, which extends `Error` and includes all `Result` fields.

```ts
import { spawn, SubprocessError } from 'pty-spawn'

try {
    await subprocess
} catch (error) {
    if (error instanceof SubprocessError) {
        error.exitCode // e.g. 1
        error.signalName // e.g. 'SIGTERM'
        error.output // captured output
    }
}
```

Abort and timeout behavior:
- `timeout` and `signal` abort the process, rejecting with `SubprocessError`
- `error.cause` contains the underlying reason (e.g. `TimeoutError`)
- If the process exits cleanly before the abort fires, success wins the race

### `waitFor(subprocess, predicate, options?)`

Wait for output to satisfy a predicate.

```ts
await waitFor(subprocess, output => output.includes('Ready'))

// With timeout
await waitFor(subprocess, output => output.includes('Ready'), {
    signal: AbortSignal.timeout(5000)
})
```

The predicate receives accumulated output (since `waitFor` was called) and can be async. Calls are serialized — a slow predicate won't run concurrently.

| Option | Type | Description |
| --- | --- | --- |
| `signal` | `AbortSignal` | Abort control (use `AbortSignal.timeout()` for timeouts) |

## Inspiration

Thanks to [execa](https://github.com/sindresorhus/execa) and [nano-spawn](https://github.com/sindresorhus/nano-spawn) for the inspiration. They proved that `await spawn(...)` is the right primitive for child processes — pty-spawn brings that model to pseudo-terminals.

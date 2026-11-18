/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import {
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  type RGBA,
  type ScrollBoxRenderable,
} from "@opentui/core"
import { useKeyboard, useTerminalDimensions, type JSX } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { Store } from "solid-js/store"
import { createSyntaxMemo } from "./syntax"

// Same instructions the built-in /btw sends, so answers behave identically.
// session.generate exposes the session's tools but runs no tool loop, so a
// tool call would surface as an empty answer.
const INSTRUCTIONS = [
  "The user is asking a quick side question about the conversation so far.",
  "Answer directly and concisely in markdown from what you already know.",
  "Do not call any tools and do not take any actions.",
].join(" ")

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const DIALOG_INSET = 3

interface Chat {
  id: string
  question: string
  status: "running" | "answered" | "failed"
  created: number
  answer?: string
  duration?: number
  error?: string
  model?: { providerID: string; id: string; variant?: string }
}

interface BtwState {
  chats: Record<string, Chat[]>
}

// Copied from the TUI's Spinner: host components are not part of the plugin
// API, while the <spinner> element itself is registered process-wide by the
// host. The host's animations setting is not exposed to plugins, so this
// always animates (the host default).
function Spinner(props: { children?: JSX.Element; color?: RGBA }) {
  return (
    <box flexDirection="row" gap={1} flexShrink={props.children ? 1 : 0}>
      <box flexShrink={0}>
        <spinner frames={SPINNER_FRAMES} interval={80} color={props.color} />
      </box>
      <Show when={props.children}>
        <text fg={props.color}>{props.children}</text>
      </Show>
    </box>
  )
}

function BtwSidebar(props: {
  context: Plugin.Context
  state: Store<BtwState>
  sessionID: string
  open: (id: string) => void
}) {
  const [view, updateView] = props.context.storage.store("view", { initial: { open: true } })
  const theme = props.context.theme
  const list = createMemo(() => [...(props.state.chats[props.sessionID] ?? [])].reverse())

  const dot = (chat: Chat) =>
    chat.status === "running"
      ? theme.hue.interactive[200]
      : chat.status === "failed"
        ? theme.text.feedback.error.base
        : theme.text.feedback.success.base

  const status = (chat: Chat) => {
    if (chat.status === "running") return "…"
    if (chat.status === "failed") return "failed"
    if (chat.duration === undefined) return ""
    return `${Math.round(chat.duration / 1000)}s`
  }

  return (
    <Show when={list().length > 0}>
      <box>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => {
            if (list().length <= 2) return
            void updateView((draft) => {
              draft.open = !draft.open
            }).catch((error) => console.error("Failed to persist BTW sidebar state", error))
          }}
        >
          <Show when={list().length > 2}>
            <text fg={theme.text.base}>{view.open ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme.text.base}>
            <b>BTW</b>
            <Show when={list().length > 2 && !view.open}>
              <span style={{ fg: theme.text.muted }}> ({list().length})</span>
            </Show>
          </text>
        </box>
        <Show when={list().length <= 2 || view.open}>
          <For each={list()}>
            {(chat) => (
              <box
                flexDirection="row"
                gap={1}
                minWidth={0}
                onMouseUp={() => props.open(chat.id)}
              >
                <text flexShrink={0} style={{ fg: dot(chat) }}>
                  •
                </text>
                <text fg={theme.text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                  {chat.question}
                </text>
                <text
                  fg={chat.status === "failed" ? theme.text.feedback.error.base : theme.text.muted}
                  wrapMode="none"
                  flexShrink={0}
                >
                  {status(chat)}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

function Answer(props: {
  context: Plugin.Context
  state: Store<BtwState>
  sessionID: string
  id: string
  copy: (text: string) => Promise<void>
}) {
  const theme = props.context.theme.surface("dialog")
  const overlay = props.context.theme
  const syntax = createSyntaxMemo(() => props.context.theme, props.context.renderer)
  const chat = createMemo(() => (props.state.chats[props.sessionID] ?? []).find((item) => item.id === props.id))
  const dimensions = useTerminalDimensions()
  const maxHeight = createMemo(() => Math.max(8, Math.floor(dimensions().height * 0.6)))
  const [copied, setCopied] = createSignal(false)
  let scroll: ScrollBoxRenderable | undefined

  const copy = () => {
    const answer = chat()?.answer
    if (!answer) return
    void props
      .copy(answer)
      .then(() => setCopied(true))
      .catch((cause) =>
        props.context.ui.toast.show({
          message: cause instanceof Error ? cause.message : String(cause),
          variant: "error",
        }),
      )
  }

  // The dialog host pushes the "modal" mode while any dialog is open, so this
  // layer is reachable exactly while this answer is shown.
  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [{ bind: "c", title: "Copy answer", group: "Dialog", run: copy }],
  }))

  useKeyboard((event) => {
    if (!scroll) return
    if (event.name === "up" || event.name === "k") return scroll.scrollBy(-1)
    if (event.name === "down" || event.name === "j") return scroll.scrollBy(1)
    if (event.name === "pageup") return scroll.scrollBy(-maxHeight())
    if (event.name === "pagedown") return scroll.scrollBy(maxHeight())
    if (event.name === "home") return scroll.scrollTo(0)
    if (event.name === "end") return scroll.scrollTo(scroll.scrollHeight)
  })

  return (
    <box paddingBottom={1} gap={1}>
      <box paddingLeft={DIALOG_INSET} paddingRight={DIALOG_INSET} flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme.text.base} flexShrink={0}>
          <b>/btw</b>
        </text>
        <text fg={theme.text.muted} wrapMode="none" flexGrow={1} truncate>
          {chat()?.question.replace(/\s+/g, " ") ?? ""}
        </text>
        <text fg={theme.text.muted} flexShrink={0}>
          esc
        </text>
      </box>
      <Show
        when={chat()}
        fallback={
          <text fg={theme.text.muted} paddingLeft={DIALOG_INSET} paddingRight={DIALOG_INSET}>
            This question no longer exists.
          </text>
        }
      >
        {/* Solid passes an accessor to a function child; call it to read the chat reactively. */}
        {(item) => (
          <Show
            when={item().status === "answered"}
            fallback={
              <box paddingLeft={DIALOG_INSET} paddingRight={DIALOG_INSET} gap={1}>
                <Show
                  when={item().status === "running"}
                  fallback={
                    <text fg={theme.text.feedback.error.base} wrapMode="word">
                      {item().error ?? "The answer failed."}
                    </text>
                  }
                >
                  <box flexDirection="row" gap={1}>
                    <Spinner color={theme.hue.interactive[200]} />
                    <text fg={theme.text.muted}>answering…</text>
                  </box>
                </Show>
              </box>
            }
          >
            <scrollbox
              ref={(element: ScrollBoxRenderable) => (scroll = element)}
              maxHeight={maxHeight()}
              contentOptions={{ minHeight: 0 }}
              backgroundColor={overlay.background.raised.high}
              scrollbarOptions={{ visible: false }}
            >
              <box paddingLeft={DIALOG_INSET} paddingRight={DIALOG_INSET} paddingTop={1} paddingBottom={1}>
                <markdown
                  syntaxStyle={syntax()}
                  content={item().answer ?? ""}
                  conceal
                  internalBlockMode="top-level"
                  tableOptions={{ style: "grid", cellPaddingX: 1 }}
                  fg={overlay.markdown.text}
                  bg={overlay.background.raised.high}
                />
              </box>
            </scrollbox>
          </Show>
        )}
      </Show>
      <box paddingLeft={DIALOG_INSET} paddingRight={DIALOG_INSET} flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme.text.muted} flexShrink={0}>
          scroll j/k ↑/↓
        </text>
        <text
          fg={copied() ? theme.text.feedback.success.base : theme.text.muted}
          flexShrink={0}
          onMouseUp={copy}
        >
          {copied() ? "✓ copied" : "copy response c"}
        </text>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "btw",
  setup(context) {
    const [state, update] = context.storage.store<BtwState>("state", { initial: { chats: {} } })
    const [pending, setPending] = createSignal(0)
    const clipboard = createClipboard({
      host: createHostClipboard(),
      terminal: createRendererClipboardAdapter(context.renderer),
    })

    const reportError = (cause: unknown) =>
      context.ui.toast.show({ message: cause instanceof Error ? cause.message : String(cause), variant: "error" })

    // Same status checks as the host clipboard adapter: OpenTUI reports
    // per-destination status instead of rejecting on a failed write.
    const copyText = async (text: string) => {
      const result = await clipboard.writeText(text.replaceAll("\0", ""), {
        destination: "all-available",
        selection: "clipboard",
      })
      if (result.host.status === "written" || result.terminal.status === "attempted") return
      if (result.host.status === "failed") throw result.host.error
      throw new Error(`Clipboard write failed (host: ${result.host.status}, terminal: ${result.terminal.status})`)
    }

    const patch = (sessionID: string, id: string, change: (chat: Chat) => void) =>
      update((draft) => {
        const chat = draft.chats[sessionID]?.find((item) => item.id === id)
        if (chat) change(chat)
      }).catch(reportError)

    const openChat = (sessionID: string, id: string) => {
      context.ui.dialog.show(() => (
        <Answer context={context} state={state} sessionID={sessionID} id={id} copy={copyText} />
      ))
      context.ui.dialog.set({ size: "large", centered: true })
    }

    const ask = async (input?: string) => {
      const route = context.ui.router.current()
      if (route.type !== "session") {
        context.ui.toast.show({ message: "Open a session first", variant: "warning" })
        return
      }
      const sessionID = route.sessionID
      const question =
        input?.trim() || (await context.ui.dialog.prompt({ title: "/btw", placeholder: "Ask anything" }))
      if (!question) return
      const id = crypto.randomUUID()
      const model = context.ui.model.current()
      // Record the question first so the sidebar shows it as running; storage
      // writes serialize under a file lock, so the answer patch lands after it.
      await update((draft) => {
        const list = (draft.chats[sessionID] ||= [])
        list.push({
          id,
          question,
          status: "running",
          created: Date.now(),
          model: model ? { providerID: model.providerID, id: model.modelID, variant: model.variant } : undefined,
        })
      }).catch(reportError)
      const started = Date.now()
      setPending((count) => count + 1)
      try {
        const result = await context.client.session.generate({
          sessionID,
          prompt: [INSTRUCTIONS, question].join("\n\n"),
        })
        await patch(sessionID, id, (chat) => {
          chat.answer = result.text.trim()
          chat.duration = Date.now() - started
          chat.status = "answered"
        })
        openChat(sessionID, id)
      } catch (cause) {
        await patch(sessionID, id, (chat) => {
          chat.status = "failed"
          chat.error = cause instanceof Error ? cause.message : String(cause)
        })
        reportError(cause)
      } finally {
        setPending((count) => count - 1)
      }
    }

    const history = async () => {
      const route = context.ui.router.current()
      if (route.type !== "session") {
        context.ui.toast.show({ message: "Open a session first", variant: "warning" })
        return
      }
      const sessionID = route.sessionID
      const list = [...(state.chats[sessionID] ?? [])].reverse()
      if (list.length === 0) {
        context.ui.toast.show({ message: "No BTW questions yet", variant: "info" })
        return
      }
      const picked = await context.ui.dialog.select({
        title: "BTW history",
        options: list.map((chat) => ({
          title: chat.question.replace(/\s+/g, " "),
          description:
            chat.status === "answered" && chat.answer
              ? chat.answer.replace(/\s+/g, " ").slice(0, 120)
              : chat.status === "running"
                ? "answering…"
                : "failed",
          value: chat.id,
        })),
      })
      if (picked) openChat(sessionID, picked)
    }

    // The built-in /btw plugin stays disabled via cli.json ("-opencode.btw");
    // reusing its command id keeps keybinds configured for "session.aside" working.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "session.aside",
          title: "Ask a side question",
          description: "One-shot answer from the session's context without adding to the conversation",
          group: "Session",
          palette: true,
          slash: { name: "btw", arguments: true },
          run: ask,
        },
        {
          id: "btw.history",
          title: "BTW history",
          description: "Browse and reopen this session's BTW answers",
          group: "Session",
          palette: true,
          slash: { name: "btws" },
          run: history,
        },
      ],
    }))

    context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <Show when={pending() > 0}>
          <box flexShrink={0}>
            <Spinner color={context.theme.hue.interactive[200]}>/btw</Spinner>
          </box>
        </Show>
      ),
    })

    context.ui.slot({
      append: "sidebar.content",
      render: (props) => (
        <BtwSidebar
          context={context}
          state={state}
          sessionID={props.sessionID}
          open={(id) => openChat(props.sessionID, id)}
        />
      ),
    })

    return () => {
      void clipboard.dispose().catch(() => {})
    }
  },
})

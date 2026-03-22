import type { ChannelPlugin } from "clawdbot/plugin-sdk";
import type { ResolvedOneBotAccount } from "./types.js";
import { listOneBotAccountIds, resolveOneBotAccount, applyOneBotAccountConfig } from "./config.js";
import { reactToMessage, sendText } from "./outbound.js";
import { startGateway } from "./gateway.js";

const DEFAULT_ACCOUNT_ID = "default";

export const onebotPlugin: ChannelPlugin<ResolvedOneBotAccount> = {
  id: "onebot",
  meta: {
    id: "onebot",
    label: "OneBot",
    selectionLabel: "OneBot (QQ via NapCat)",
    docsPath: "/docs/channels/onebot",
    blurb: "Connect to QQ via OneBot 11 protocol (NapCat/go-cqhttp)",
    order: 55,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    threads: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: {
      minChars: 80,
      idleMs: 600,
    },
  },
  reload: { configPrefixes: ["channels.onebot"] },
  agentPrompt: {
    messageToolHints: () => [
      "To send an image or file, use the message tool with action='send' and set 'media' to a local file path (absolute, e.g. /tmp/photo.png) or an HTTPS image URL. Example: --media https://example.com/image.png or --media /tmp/screenshot.png",
      "When generating or saving a file to send, always use an absolute path (e.g. /tmp/photo.png), never a relative path.",
      "You can send both text and media in a single message by providing both --message and --media.",
    ],
  },
  messaging: {
    normalizeTarget: (target) => {
      return target.replace(/^onebot:/i, "");
    },
    targetResolver: {
      looksLikeId: (id) => {
        const normalized = id.replace(/^onebot:/i, "");
        if (normalized.startsWith("private:")) return /^private:\d+$/.test(normalized);
        if (normalized.startsWith("group:")) return /^group:\d+$/.test(normalized);
        return /^\d+$/.test(normalized);
      },
      hint: "private:<user_id> or group:<group_id>",
    },
  },
  config: {
    listAccountIds: (cfg) => listOneBotAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveOneBotAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => Boolean(account?.wsUrl && account?.httpUrl),
    describeAccount: (account) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.wsUrl && account?.httpUrl),
    }),
  },
  setup: {
    validateInput: ({ input }) => {
      if (!input.token && !input.useEnv) {
        return "OneBot requires --token (format: wsUrl,httpUrl[,accessToken]) or --use-env (ONEBOT_WS_URL, ONEBOT_HTTP_URL)";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      let wsUrl = "";
      let httpUrl = "";
      let accessToken: string | undefined;

      if (input.token) {
        const parts = input.token.split(",");
        wsUrl = parts[0] ?? "";
        httpUrl = parts[1] ?? "";
        accessToken = parts[2];
      }

      return applyOneBotAccountConfig(cfg, accountId, {
        wsUrl,
        httpUrl,
        accessToken,
        name: input.name,
      });
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4500,
    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      const account = resolveOneBotAccount(cfg, accountId);
      const result = await sendText({ to, text, accountId, replyToId, account });
      return {
        channel: "onebot",
        messageId: result.messageId,
        error: result.error ? new Error(result.error) : undefined,
      };
    },
    sendMedia: async (ctx) => {
      console.log(`[onebot-sendMedia] CALLED! mediaUrl=${ctx.mediaUrl} to=${ctx.to} text=${(ctx.text ?? "").slice(0, 50)}`);
      const account = resolveOneBotAccount(ctx.cfg, ctx.accountId);
      if (!account.httpUrl) {
        throw new Error("OneBot not configured (missing httpUrl)");
      }

      const mediaUrl = ctx.mediaUrl;
      const to = ctx.to;
      const text = ctx.text ?? "";

      // Parse target
      let normalized = to.replace(/^onebot:/i, "");
      let targetType: "private" | "group" = "private";
      let targetId: number;
      if (normalized.startsWith("group:")) {
        targetType = "group";
        targetId = Number(normalized.slice(6));
      } else if (normalized.startsWith("private:")) {
        targetId = Number(normalized.slice(8));
      } else {
        targetId = Number(normalized);
      }

      // Send image if mediaUrl is provided
      if (mediaUrl) {
        try {
          const { sendImage } = await import("./outbound.js");
          let fileRef: string;

          if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
            // URL: pass directly to NapCat
            fileRef = mediaUrl;
          } else {
            // Local file: copy to NapCat-accessible directory (QQ runs in macOS sandbox)
            const localPath = mediaUrl.startsWith("file://") ? mediaUrl.slice(7) : mediaUrl;
            const { copyFile, mkdir } = await import("node:fs/promises");
            const { join, basename } = await import("node:path");
            const napCatMediaDir = join(
              process.env.HOME ?? "/Users/yui",
              "Library/Containers/com.tencent.qq/Data/Documents/napcat/media-outbound",
            );
            await mkdir(napCatMediaDir, { recursive: true });
            const destPath = join(napCatMediaDir, `${Date.now()}-${basename(localPath)}`);
            await copyFile(localPath, destPath);
            fileRef = `file://${destPath}`;
            console.log(`[onebot-sendMedia] copied local file to NapCat sandbox: ${localPath} → ${destPath}`);
          }

          console.log(`[onebot-sendMedia] sending image: fileRef=${fileRef} target=${targetType}:${targetId}`);
          const result = await sendImage(account, targetType, targetId, fileRef);
          console.log(`[onebot-sendMedia] sendImage result: ${JSON.stringify(result)}`);
        } catch (err) {
          console.error(`[onebot-sendMedia] sendImage error: ${err}`);
        }
      }

      // Send text if any
      if (text.trim()) {
        const result = await sendText({ to, text, account });
        return {
          channel: "onebot",
          messageId: result.messageId,
          error: result.error ? new Error(result.error) : undefined,
        };
      }

      return { channel: "onebot" };
    },
  },
  actions: {
    listActions: () => ["react"],
    supportsAction: ({ action }) => action === "react",
    handleAction: async ({ action, cfg, params, accountId, toolContext }) => {
      if (action !== "react") {
        return {
          ok: false,
          error: `Unsupported OneBot action: ${action}`,
          content: [{ type: "text", text: `Unsupported OneBot action: ${action}` }],
        };
      }

      const messageId =
        params.message_id ??
        params.messageId ??
        params.message ??
        toolContext?.currentMessageId;
      const emojiId =
        params.emoji_id ??
        params.emojiId ??
        params.emoji ??
        params.reaction;

      if (messageId == null || emojiId == null || String(emojiId).trim() === "") {
        return {
          ok: false,
          error: "OneBot react requires `emoji` and `message_id` (or current message context).",
          content: [
            {
              type: "text",
              text: "OneBot react requires `emoji` and `message_id` (or current message context).",
            },
          ],
        };
      }

      const account = resolveOneBotAccount(cfg, accountId);
      const result = await reactToMessage(account, messageId as string | number, emojiId as string | number);

      if (!result.ok) {
        return {
          ok: false,
          error: result.error ?? "OneBot reaction failed",
          content: [{ type: "text", text: result.error ?? "OneBot reaction failed" }],
          data: result,
        };
      }

      return {
        ok: true,
        data: result,
        content: [
          {
            type: "text",
            text: `Reacted with ${String(emojiId)} to message ${String(messageId)}.`,
          },
        ],
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account, abortSignal, log, cfg } = ctx;

      log?.info(`[onebot:${account.accountId}] Starting gateway`);

      await startGateway({
        account,
        abortSignal,
        cfg,
        log,
        onReady: () => {
          log?.info(`[onebot:${account.accountId}] Gateway ready`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
          });
        },
        onError: (error) => {
          log?.error(`[onebot:${account.accountId}] Gateway error: ${error.message}`);
          ctx.setStatus({
            ...ctx.getStatus(),
            lastError: error.message,
          });
        },
      });
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.wsUrl && account?.httpUrl),
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
};

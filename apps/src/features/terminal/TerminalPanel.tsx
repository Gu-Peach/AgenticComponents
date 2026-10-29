import { useState } from "react";
import { Download, Trash2, Copy, Terminal } from "lucide-react";
import { useWorkspace } from "@/stores/workspace";
import { executeConsole, reportError } from "@/commands/workspaceCommands";
import { download } from "@/services/BrowserProjectRepository";
export function TerminalPanel() {
  const logs = useWorkspace((s) => s.logs);
  const [command, setCommand] = useState("");
  const [filter, setFilter] = useState("all");
  const text = logs
    .map((l) => `${l.time} [${l.level}] ${l.message}`)
    .join("\n");
  return (
    <div className="terminal-panel">
      <div className="panel-toolbar">
        <span>
          <Terminal size={14} />
          应用控制台 <small>不连接系统 Shell</small>
        </span>
        <div className="row">
          <select
            aria-label="日志级别"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">全部级别</option>
            <option value="error">错误</option>
            <option value="info">信息</option>
          </select>
          <button
            aria-label="复制日志"
            title="复制日志"
            onClick={() =>
              navigator.clipboard.writeText(text).catch(reportError)
            }
          >
            <Copy size={13} />
          </button>
          <button
            aria-label="导出日志"
            title="导出日志"
            onClick={() => download("workbench.log", text, "text/plain")}
          >
            <Download size={13} />
          </button>
          <button
            aria-label="清空日志"
            title="清空日志"
            onClick={() => useWorkspace.setState({ logs: [] })}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <div className="log-list" role="log">
        {logs
          .filter((l) => filter === "all" || l.level === filter)
          .map((l) => (
            <div className={`log-line ${l.level}`} key={l.id}>
              <time>{l.time}</time>
              <span>{l.level.toUpperCase()}</span>
              <pre>{l.message}</pre>
            </div>
          ))}
        {!logs.length && (
          <p className="muted">暂无日志。输入 help 查看可用命令。</p>
        )}
      </div>
      <form
        className="terminal-input"
        onSubmit={(e) => {
          e.preventDefault();
          executeConsole(command).catch(reportError);
          setCommand("");
        }}
      >
        <span>❯</span>
        <input
          aria-label="应用命令"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="输入 help 查看命令"
          autoComplete="off"
          spellCheck={false}
        />
        <kbd>Enter</kbd>
      </form>
    </div>
  );
}

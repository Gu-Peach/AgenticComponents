"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="boot-screen">
      <h1>工作台遇到错误</h1>
      <p>可以重新打开工作台，浏览器内已保存的项目会保留。</p>
      <button onClick={reset}>重新加载</button>
    </div>
  );
}

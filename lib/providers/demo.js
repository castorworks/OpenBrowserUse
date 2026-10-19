// Fixed script that drives the same tool loop without calling a model (the "本地演示").
export class DemoProvider {
  constructor() { this.turn = 0; this.last = ''; this.id = 0; }
  addUserText() {}
  addToolResults(results) { this.last = results.map(r => r.text).join('\n'); }
  ref(label) { return new RegExp(`"[^"]*${label}[^"]*" \\[(ref_\\d+)\\]`).exec(this.last)?.[1]; }
  call(name, input) { return { id: `demo_${++this.id}`, name, input }; }
  async step() {
    const turn = this.turn++;
    if (turn === 0) return { stop: 'tool_use', text: '先读取页面结构。', notes: [], toolCalls: [this.call('read_page', {})] };
    if (turn === 1) return { stop: 'tool_use', text: '填写关键词并搜索。', notes: [], toolCalls: [this.call('form_input', { ref: this.ref('产品关键词'), value: '键盘' }), this.call('computer', { action: 'left_click', ref: this.ref('搜索产品') })] };
    if (turn === 2) return { stop: 'tool_use', text: '读取搜索结果。', notes: [], toolCalls: [this.call('get_page_text', {})] };
    return { stop: 'end_turn', notes: [], toolCalls: [], text: `演示完成：真实浏览器已打开本地页面，用 read_page 找到输入框，用 form_input 填写关键词并点击搜索。\n\n${this.last}\n\n这是固定脚本演示，尚未调用 AI。` };
  }
}

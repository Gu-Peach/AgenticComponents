/** 登记当前运行中已占用的对象 ID，检查重复占用，并在清理时统一释放登记。 */

export class RunOwnership {
  private owners = new Set<string>();
  claim(id: string) {
    if (this.owners.has(id)) throw new Error("运行对象已被占用");
    this.owners.add(id);
  }
  clear() {
    this.owners.clear();
  }
}

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

// GPU pass timing via EXT_disjoint_timer_query_webgl2 (debug only: ?profile).
export class Profiler {
  constructor(gl, enabled) {
    this.gl = gl;
    this.ext = enabled ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
    this.pending = [];
    this.stats = {};
  }
  begin(name) {
    if (!this.ext) return;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.current = { name, q };
  }
  end() {
    if (!this.ext || !this.current) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.current);
    this.current = null;
  }
  section(name) { this.end(); this.begin(name); }
  poll() {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    this.pending = this.pending.filter(({ name, q }) => {
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return true;
      if (!disjoint) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        const s = (this.stats[name] ||= { avg: ms, n: 0 });
        s.avg = s.avg * 0.9 + ms * 0.1;
        s.n++;
      }
      gl.deleteQuery(q);
      return false;
    });
  }
  report() {
    return Object.fromEntries(Object.entries(this.stats).map(([k, v]) => [k, +v.avg.toFixed(2)]));
  }
}

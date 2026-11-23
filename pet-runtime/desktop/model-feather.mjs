// Post-process only the lower strip of the existing resolved canvas. Keeping the
// original model draw preserves its MSAA and every pixel above the scissor band.
export class ModelFeather {
  constructor(gl) { this.gl = gl; this.allocations = 0; }
  init() {
    const gl = this.gl;
    this.vaoExtension = gl.getExtension('OES_vertex_array_object');
    const shader = (type, source) => {
      const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const error = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error(error); }
      return s;
    };
    const vertex = shader(gl.VERTEX_SHADER, 'attribute vec2 position; void main(){gl_Position=vec4(position,0.0,1.0);}');
    const fragment = shader(gl.FRAGMENT_SHADER, `
      precision highp float;
      uniform sampler2D image;
      uniform vec2 textureSize;
      uniform float band, radius;
      void main(){
        vec2 uv=gl_FragCoord.xy/textureSize;
        float keep=smoothstep(0.0,band,gl_FragCoord.y);
        vec2 d=vec2(radius*(1.0-keep))/textureSize;
        vec4 c=texture2D(image,uv)*0.28;
        c+=(texture2D(image,uv+vec2(d.x,0.0))+texture2D(image,uv-vec2(d.x,0.0))
           +texture2D(image,uv+vec2(0.0,d.y))+texture2D(image,uv-vec2(0.0,d.y)))*0.12;
        c+=(texture2D(image,uv+d)+texture2D(image,uv-d)
           +texture2D(image,uv+vec2(d.x,-d.y))+texture2D(image,uv+vec2(-d.x,d.y)))*0.06;
        // Blur premultiplied color and alpha together, then fade both together.
        gl_FragColor=c*keep;
      }`);
    this.program = gl.createProgram(); gl.attachShader(this.program, vertex); gl.attachShader(this.program, fragment); gl.bindAttribLocation(this.program, 0, 'position'); gl.linkProgram(this.program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    this.uniforms = Object.fromEntries(['image','textureSize','band','radius'].map(name => [name, gl.getUniformLocation(this.program, name)]));
    if (this.vaoExtension) { this.vao = this.vaoExtension.createVertexArrayOES(); this.vaoExtension.bindVertexArrayOES(this.vao); }
    this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
    if (this.vaoExtension) this.bindPosition();
  }
  bindPosition() { const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); }
  apply(canvas) {
    const gl = this.gl;
    // VAO 扩展只探测一次（旧实现每帧 getExtension）。必须在下方的属性快照之前拿到：
    // 有 VAO 就不用保存默认 VAO 的顶点属性；没有才需要逐项保存/恢复。
    const vao = this.vaoExtension === undefined
      ? (this.vaoExtension = gl.getExtension('OES_vertex_array_object') || null)
      : this.vaoExtension;
    // WebGL1 without VAOs: restore exactly the one attribute this pass changes.
    // （有 VAO 的平台走独立 VAO，默认 VAO 的属性状态不被动过。）
    const attribute = vao ? null : Object.fromEntries(['BUFFER_BINDING','ENABLED','SIZE','TYPE','NORMALIZED','STRIDE'].map(key => [key, gl.getVertexAttrib(0, gl['VERTEX_ATTRIB_ARRAY_' + key])]));
    // A null attribute pointer cannot be restored through WebGL1. Keep the model
    // visible and report a degraded effect instead of disrupting its draw loop.
    if (attribute && !attribute.BUFFER_BINDING) { this.status = 'unavailable-attribute-state'; return false; }
    if (attribute) attribute.offset = gl.getVertexAttribOffset(0, gl.VERTEX_ATTRIB_ARRAY_POINTER);
    if (!this.program) this.init();
    try {
      const scale = canvas.height / Math.max(1, canvas.clientHeight);
      this.bandCss = canvas.clientHeight * .14; this.radiusCss = canvas.clientHeight / 340 * 2.75;
      const band = this.bandCss * scale, radius = this.radiusCss * scale;
      const width = canvas.width, height = Math.min(canvas.height, Math.ceil(band + radius + 2));
      if (!this.texture) this.texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      if (this.width !== width || this.height !== height) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.width = width; this.height = height; this.allocations++;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
      // ── 只设置本 pass 必需的 GL 状态（2026-11-22 性能）─────────────────
      // 旧实现每帧保存并恢复全部 GL 状态（8×getParameter + 6×isEnabled + 20 余次
      // 恢复调用），实测羽毛层 1.4ms/帧，其中绝大部分是对下一帧毫无意义的白做：
      //   · 下一帧 draw() 显式 viewport/clearColor/clear；
      //   · CubismRenderer_WebGL.setRenderState() 重新 bindFramebuffer+viewport；
      //   · drawModel() 的 preDraw() disable SCISSOR/STENCIL/DEPTH、enable BLEND、
      //     colorMask(true)、解绑 ARRAY/ELEMENT buffer；
      //   · 每个 mesh 的 setupShaderProgram 重新 useProgram/bindTexture/设属性指针。
      // 所以只保留「下一帧 clear 之前必须成立」的收尾：scissor 关、colorMask 全开、
      // 默认 framebuffer、解绑 VAO（否则 SDK 的 bindBuffer/vertexAttribPointer 会
      // 被记进羽毛的 VAO，模型画不出来）。
      gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST);
      gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, width, Math.ceil(band));
      gl.colorMask(true,true,true,true); gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(this.program); if (vao) vao.bindVertexArrayOES(this.vao); else this.bindPosition();
      gl.uniform1i(this.uniforms.image, 0); gl.uniform2f(this.uniforms.textureSize, width, height); gl.uniform1f(this.uniforms.band, band); gl.uniform1f(this.uniforms.radius, radius);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.status = vao ? 'vao-minstate' : 'restored-attribute';
      return true;
    } finally {
      if (vao) vao.bindVertexArrayOES(null);
      else { gl.bindBuffer(gl.ARRAY_BUFFER, attribute.BUFFER_BINDING); gl.vertexAttribPointer(0, attribute.SIZE, attribute.TYPE, attribute.NORMALIZED, attribute.STRIDE, attribute.offset); attribute.ENABLED ? gl.enableVertexAttribArray(0) : gl.disableVertexAttribArray(0); }
      gl.disable(gl.SCISSOR_TEST);
      gl.enable(gl.BLEND);
      gl.enable(gl.DITHER);          // 默认开启；关着会让渐变出现色带
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(null);
    }
  }
  releaseTexture() { if (this.texture) this.gl.deleteTexture(this.texture); this.texture = null; this.width = this.height = 0; }
  dispose() { this.releaseTexture(); if (this.program) this.gl.deleteProgram(this.program); if (this.buffer) this.gl.deleteBuffer(this.buffer); if (this.vao) this.vaoExtension.deleteVertexArrayOES(this.vao); this.program = this.buffer = this.vao = null; }
}

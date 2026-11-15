// LUNA-DOC: Interactive 3D surface in Open charts, drawn using a 2D canvas.
// LUNA-DOC: Camera rotation is handled here without creating another WebGL context.
// LUNA-DOC: Missing source samples must not be connected into fictitious topography.
/** Interactive 3D height-field chart, rendered in a dedicated 2D canvas.
 * True X/Y/Z geometry is projected with an orbitable camera. No extra WebGL
 * context or 3D dependencies compete with Cesium's renderer.
 * Missing measurements remain holes; values outside the geodesic disk are hidden.
 */
// LUNA-DOC: The clamp helper constrains values; verify its callers before editing it.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const colors = [
    [52, 26, 242], [0, 74, 255], [0, 158, 255], [0, 232, 255],
    [0, 234, 116], [242, 249, 0], [255, 128, 0], [247, 16, 43],
];
// LUNA-DOC: The rgb helper constructs colors; verify its callers before editing it.
const rgb = (fraction, shade = 1) => {
    const scaled = clamp(fraction, 0, 1) * (colors.length - 1);
    const i = Math.floor(scaled), j = Math.min(i + 1, colors.length - 1);
    const t = scaled - i;
    return `rgb(${colors[i].map((channel, k) => Math.round((channel * (1 - t) + colors[j][k] * t) * shade)).join(',')})`;
};

// LUNA-DOC: Create an interactive 3D model from zone nodes for Open charts.
export function createZoneSurfaceChart(canvas, onProbe = () => {}) {
    const ctx = canvas.getContext('2d', { alpha: false });
    let yaw = -0.75;
    let pitch = 0.72;
    let zoom = 1;
    let triangles = [];
    let samples = [];
    let measureMin = 0;
    let measureMax = 1;
    let rangeLabel = '';
    let gridSize = 0;
    let dragging = null;
    let loaded = false;
    let selectedValue = null;

    // LUNA-DOC: Project 3D points onto 2D canvas coordinates.
    function cameraProjection(x, y, z, width, height) {
        const u = x * Math.cos(yaw) - y * Math.sin(yaw);
        const d = x * Math.sin(yaw) + y * Math.cos(yaw);
        const vertical = z * Math.cos(pitch) - d * Math.sin(pitch);
        const scale = Math.min((width - 80) / 4.1, (height - 65) / 2.6) * zoom;
        const perspective = 4.6 / (4.6 - d * 0.35);
        return { x: width / 2 + u * scale * perspective, y: height * 0.55 - vertical * scale * perspective, d };
    }

    // LUNA-DOC: Render visible surface triangles in depth order.
    function paint() {
        const bounds = canvas.getBoundingClientRect();
        const width = bounds.width, height = bounds.height;
        if (width < 20 || height < 20) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.round(width * dpr), h = Math.round(height * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w; canvas.height = h;
        }
        ctx.setTransform(w / width, 0, 0, h / height, 0, 0);
        ctx.fillStyle = '#0f131d';
        ctx.fillRect(0, 0, width, height);
        // LUNA-DOC: The project helper transforms coordinates; verify its callers before editing it.
        const project = (x,y,z) => cameraProjection(x,y,z,width,height);
        // LUNA-DOC: The line helper draws a segment; verify its callers before editing it.
        const line = (a,b,color = '#394458',thickness=1) => {
            const A=project(...a),B=project(...b);
            ctx.beginPath();ctx.moveTo(A.x,A.y);ctx.lineTo(B.x,B.y);
            ctx.strokeStyle=color;ctx.lineWidth=thickness;ctx.stroke();
        };
        // Lower datum plane and measurement guides are always visible.
        for (let t = -1; t <= 1.01; t += .5) {
            line([-1,t,0],[1,t,0]); line([t,-1,0],[t,1,0]);
        }
        if (!loaded) {
            ctx.fillStyle='#aebbd1';ctx.font='14px Inter, system-ui, sans-serif';
            ctx.textAlign='center';ctx.fillText('No measured zone grid available',width/2,height/2);
            return;
        }
        const ordered=triangles.map(face=>{
            const pts=face.p.map(k=>samples[k]);
            const nodes=pts.map(p=>project(p.x,p.y,p.z));
            return {nodes,depth:nodes.reduce((a,p)=>a+p.d,0)/3,colour:face.colour};
        }).sort((a,b)=>a.depth-b.depth);
        for (const face of ordered) {
            const [a,b,c]=face.nodes;
            ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.lineTo(c.x,c.y);ctx.closePath();
            ctx.fillStyle=face.colour;ctx.fill();
            ctx.strokeStyle='rgba(11,17,33,.18)';ctx.lineWidth=.55;ctx.stroke();
        }
        for (const [A,B] of [ [[-1,-1,0],[1,-1,0]],[[1,-1,0],[1,1,0]],[[1,1,0],[-1,1,0]],[[-1,1,0],[-1,-1,0]],[[-1,-1,0],[-1,-1,1.8]] ]) {
            line(A,B,'#a3b0c8',1.15);
        }
        ctx.textAlign='center';ctx.font='12px Inter, system-ui, sans-serif';ctx.fillStyle='#bdcbe3';
        for (const [text,x,y,z] of [
            ['East →',0,-1.27,0],['North →',1.29,0,0],
            [`${measureMax.toLocaleString('en-GB',{maximumFractionDigits:2})} ${rangeLabel}`,-1.33,-1,1.8],
            [`${measureMin.toLocaleString('en-GB',{maximumFractionDigits:2})} ${rangeLabel}`,-1.31,-1,0],
        ]) {
            const p=project(x,y,z);
            ctx.fillText(text,p.x,p.y);
        }
        if (selectedValue !== null) onProbe(selectedValue);
    }

    // LUNA-DOC: Load a new grid of elevation and color values for the selected time.
    function setFrame(frame, metric, unit) {
        triangles=[];samples=[];selectedValue=null;loaded=false;
        const n=frame?.grid_size;
        const values=frame?.fields?.[metric]?.values;
        if (!Number.isInteger(n) || !Array.isArray(values) || values.length !== n*n) {paint(); return false;}
        const finite=values.filter(Number.isFinite);
        if (!finite.length) {paint();return false;}
        measureMin=Math.min(...finite); measureMax=Math.max(...finite);
        rangeLabel=unit;
        gridSize=n;
        const span=Math.max(measureMax-measureMin,1e-12);
        const step=Math.max(1,Math.ceil((n-1)/46));
        const cols=[];for(let c=0;c<n;c+=step)cols.push(c);if(cols.at(-1)!==n-1)cols.push(n-1);
        const rows=[];for(let r=0;r<n;r+=step)rows.push(r);if(rows.at(-1)!==n-1)rows.push(n-1);
        const lookup = new Map();
        for(const r of rows)for(const c of cols){
            const v=values[r*n+c];if(!Number.isFinite(v))continue;
            const x=2*c/(n-1)-1, y=1-2*r/(n-1);
            const z=(measureMax===measureMin ? .7 : .12+1.66*(v-measureMin)/span);
            const index=samples.length;
            samples.push({x,y,z,v});lookup.set(r*n+c,index);
        }
        // LUNA-DOC: Add a geometric node or face to the buffer.
        function add(a,b,c) {
            if ([a,b,c].some(key=>!lookup.has(key)))return;
            const indices=[lookup.get(a),lookup.get(b),lookup.get(c)];
            const v=indices.reduce((sum,i)=>sum+samples[i].v,0)/3;
            const [p,q,r]=indices.map(i=>samples[i]);
            // Small ambient shading from triangle slope; colours are based on measured values.
            const dx=(q.z-p.z)*(r.y-p.y)-(r.z-p.z)*(q.y-p.y);
            const dy=(q.x-p.x)*(r.z-p.z)-(r.x-p.x)*(q.z-p.z);
            const shade=clamp(.86+.20*dx-.13*dy,.67,1.04);
            triangles.push({p:indices,colour:rgb((v-measureMin)/span,shade)});
        }
        for(let yi=0;yi<rows.length-1;yi++)for(let xi=0;xi<cols.length-1;xi++){
            const r=rows[yi],nextR=rows[yi+1], c=cols[xi],nextC=cols[xi+1];
            add(r*n+c,nextR*n+c,r*n+nextC);
            add(r*n+nextC,nextR*n+c,nextR*n+nextC);
        }
        loaded=triangles.length>0;
        paint();return loaded;
    }

    // LUNA-DOC: Reset the 3D camera to its initial angle.
    function resetView() {yaw=-.75;pitch=.72;zoom=1;paint();}
    canvas.addEventListener('pointerdown',event=>{
        if(event.button!==0)return;
        dragging={id:event.pointerId,x:event.clientX,y:event.clientY};
        canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove',event=>{
        if(!dragging||dragging.id!==event.pointerId)return;
        yaw+=(event.clientX-dragging.x)*.008;
        pitch=clamp(pitch+(event.clientY-dragging.y)*.006,.16,1.43);
        dragging.x=event.clientX;dragging.y=event.clientY;paint();
    });
    for(const type of ['pointerup','pointercancel'])canvas.addEventListener(type,()=>{dragging=null;});
    canvas.addEventListener('wheel',event=>{
        if(!loaded)return;
        event.preventDefault();zoom=clamp(zoom*Math.exp(-event.deltaY*.001),.55,2.2);paint();
    },{passive:false});
    canvas.addEventListener('keydown',event=>{
        const shifts={ArrowLeft:[-.12,0],ArrowRight:[.12,0],ArrowUp:[0,.10],ArrowDown:[0,-.10]};
        if(!shifts[event.key])return;
        event.preventDefault();yaw+=shifts[event.key][0];pitch=clamp(pitch+shifts[event.key][1],.16,1.43);paint();
    });
    new ResizeObserver(paint).observe(canvas);
    return {setFrame,resetView,render:paint};
}

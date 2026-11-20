export function qrSvgDocument(svg: SVGSVGElement): string {
  // react-qr-code renders a module-aligned viewBox without a quiet zone.
  const width = svg.viewBox.baseVal.width;
  if (!Number.isInteger(width) || width < 21 || width > 177) throw new Error('QR inválido');
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.removeAttribute('class'); clone.removeAttribute('style');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', '1024'); clone.setAttribute('height', '1024');
  clone.setAttribute('viewBox', `-4 -4 ${width + 8} ${width + 8}`);
  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  background.setAttribute('x', '-4'); background.setAttribute('y', '-4');
  background.setAttribute('width', String(width + 8)); background.setAttribute('height', String(width + 8));
  background.setAttribute('fill', '#ffffff'); clone.insertBefore(background, clone.firstChild);
  return new XMLSerializer().serializeToString(clone);
}
export function downloadCommercialAsset(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  // Allow the browser to consume the object URL before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function qrPng(svgText: string): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svgText], {type:'image/svg+xml'}));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload=()=>resolve(); image.onerror=()=>reject(new Error('No se pudo generar la imagen')); image.src=url; });
    const canvas = document.createElement('canvas'); canvas.width=1024; canvas.height=1024;
    const ctx=canvas.getContext('2d'); if (!ctx) throw new Error('No se pudo generar la imagen');
    ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,1024,1024); ctx.drawImage(image,0,0,1024,1024);
    return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('No se pudo generar la imagen')),'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

/** Diagnostic-only contact sheets. Source canvases are copied at integer
 * native coordinates with the three-argument drawImage overload: no rescale,
 * crop, filter, or production renderer changes. */
export function createNativeInspectionSheet(title, groups) {
  const columns=3, columnWidth=630, headerHeight=76, groupTitleHeight=38, labelHeight=38, rowGap=16;
  const layouts=groups.map(group=>{
    const rows=[];
    for(let index=0;index<group.items.length;index+=columns){
      const items=group.items.slice(index,index+columns);
      for(const {canvas} of items) if(canvas.width>columnWidth || !canvas.width || !canvas.height) {
        throw new Error('检查画面超出原生 630 像素列宽，已停止导出以避免缩放。');
      }
      rows.push({items,height:Math.max(...items.map(item=>item.canvas.height))+labelHeight+rowGap});
    }
    return {...group,rows,height:groupTitleHeight+rows.reduce((height,row)=>height+row.height,0)};
  });
  const sheet=document.createElement('canvas'); sheet.width=columns*columnWidth;
  sheet.height=headerHeight+layouts.reduce((height,group)=>height+group.height,0);
  const context=sheet.getContext('2d'); context.fillStyle='#f3f7f8'; context.fillRect(0,0,sheet.width,sheet.height);
  context.fillStyle='#21323b'; context.font='bold 24px system-ui,sans-serif'; context.fillText(title,16,31);
  context.font='15px system-ui,sans-serif'; context.fillText('Native 1:1 pixels · each column 630 px · source canvases copied without rescaling',16,59);
  let y=headerHeight;
  for(const group of layouts){
    context.fillStyle='#dfe9ed'; context.fillRect(0,y,sheet.width,groupTitleHeight);
    context.fillStyle='#21323b'; context.font='bold 19px system-ui,sans-serif'; context.fillText(group.label,16,y+26); y+=groupTitleHeight;
    for(const row of group.rows){
      for(const [column,{canvas,label}] of row.items.entries()){
        const x=column*columnWidth+Math.floor((columnWidth-canvas.width)/2);
        context.drawImage(canvas,x,y);
        context.fillStyle='#21323b'; context.font='16px system-ui,sans-serif';
        context.fillText(label,column*columnWidth+12,y+row.height-rowGap-12,columnWidth-24);
      }
      y+=row.height;
    }
  }
  return sheet;
}

export function addInspectionDownload(parent,{id,label,title,filename,groups}) {
  const button=document.createElement('button'); button.type='button'; button.id=id; button.textContent=label;
  button.addEventListener('click',()=>{
    button.disabled=true;
    try {
      const sheet=createNativeInspectionSheet(title,typeof groups==='function'?groups():groups);
      sheet.toBlob(blob=>{
        if(!blob){button.disabled=false;button.textContent='导出失败，请重试';return;}
        const url=URL.createObjectURL(blob),link=document.createElement('a'); link.href=url;link.download=filename;
        document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
        button.disabled=false;button.textContent=label;button.dataset.dimensions=`${sheet.width}x${sheet.height}`;
      },'image/png');
    }catch(error){button.disabled=false;button.textContent=`导出失败：${error.message}`;}
  });
  parent.append(button);return button;
}

export function rotatedSpineFixture() {
    const width=96,height=88,background=new Uint8ClampedArray(width*height*4);
    const bbox={x0:33,y0:18,x1:52,y1:65},foreground=[245,223,157,255];
    const offset=(x:number,y:number)=>(y*width+x)*4;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const shade=29+Math.floor(Math.abs(x-43)*.65)+(x>=48?2:0);
        background.set([shade,shade+2,shade+15,255],offset(x,y));
    }
    background.set([215,137,31,255],offset(5,42));
    const pixels=background.slice();
    for(const top of [22,46])for(let y=top;y<top+14;y++)for(let x=33;x<49;x++){
        if(x<36||x>=46||y===top+6||y===top+7)pixels.set(foreground,offset(x,y));
    }
    const fringe=offset(32,25);
    const mixed=foreground.map((value,channel)=>Math.round((value+3*background[fringe+channel])/4));
    pixels.set(mixed,fringe);
    const region={text:'OPEN PANEL',bbox,sourceBoxes:[bbox],fontSize:19,quarterTurn:1 as const};
    return {width,height,background,pixels,region,offset,foreground};
}

import {describe,expect,it} from 'vitest';
import {createImageLoadTracker} from '@/src/features/image-translation/content/imageLoads';

const image = (complete=true,width=100) => ({src:'source-one',currentSrc:'',complete,naturalWidth:width}) as HTMLImageElement;
const load = (target:HTMLImageElement|null) => ({target}) as Event;
describe('原图加载版本与事件所有权',()=>{
    it('同地址再次加载递增版本，捕获与目标收到同一个事件只更新一次',()=>{
        const tracker=createImageLoadTracker(),source=image(),event=load(source);
        expect(tracker.revision(source)).toBe(0);tracker.loaded(event);tracker.loaded(event);
        expect(tracker.revision(source)).toBe(1);tracker.loaded(load(source));expect(tracker.revision(source)).toBe(2);
    });
    it.each([[false,100],[true,0]])('未加载原图首次 load 不视为重载，complete=%s width=%s',(complete,width)=>{
        const tracker=createImageLoadTracker(),source=image(complete as boolean,width as number);
        tracker.revision(source);tracker.loaded(load(source));expect(tracker.revision(source)).toBe(0);
        tracker.loaded(load(source));expect(tracker.revision(source)).toBe(1);
    });
    it('新地址的首次加载不重复失效，响应式 currentSrc 变化后再次加载仍递增',()=>{
        const tracker=createImageLoadTracker(),source=image();tracker.revision(source);
        source.src='source-two';tracker.loaded(load(source));expect(tracker.revision(source)).toBe(0);
        Object.defineProperty(source,'currentSrc',{value:'responsive-two'});tracker.loaded(load(source));expect(tracker.revision(source)).toBe(0);
        tracker.loaded(load(source));expect(tracker.revision(source)).toBe(1);
    });
    it('未登记图片和非图片 load 不保留对象，重置清除版本和事件身份',()=>{
        const tracker=createImageLoadTracker(),source=image(),event=load(source);
        tracker.loaded(event);tracker.loaded(load(null));expect(tracker.revision(source)).toBe(0);
        tracker.loaded(event);expect(tracker.revision(source)).toBe(1);tracker.reset();
        tracker.loaded(event);expect(tracker.revision(source)).toBe(0);
        tracker.loaded(event);expect(tracker.revision(source)).toBe(1);
    });
    it('捕获处理后才登记的新图片不会在目标阶段重复计入首次 load',()=>{
        const tracker=createImageLoadTracker(),source=image(),event=load(source);
        tracker.markHandled(event);expect(tracker.revision(source)).toBe(0);
        tracker.loaded(event);expect(tracker.revision(source)).toBe(0);
        tracker.loaded(load(source));expect(tracker.revision(source)).toBe(1);
    });
});

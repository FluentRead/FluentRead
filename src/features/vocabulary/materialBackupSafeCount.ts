import {MaterialError} from './materialModel';

/** Guard backup byte and frame counts against precision loss. */
export function assertMaterialBackupSafeCount(value:number, message:string):void {
    if (!Number.isSafeInteger(value)) throw new MaterialError('limit-exceeded',message);
}

import { fromFile } from 'geotiff';

const tiff = await fromFile('data-prep/raw/M20_JezeroCrater_CTXDEM_20m.tif');
const img = await tiff.getImage();

const w = img.getWidth();
const h = img.getHeight();
const [rx, ry] = img.getResolution();

console.log('pixels:        ', w, 'x', h);
console.log('pixel size:    ', Math.abs(rx), 'x', Math.abs(ry), '(map units per pixel)');
console.log('bounding box:  ', img.getBoundingBox());
console.log('bits/sample:   ', img.getBitsPerSample());
console.log('sample format: ', img.getSampleFormat(), '(1=uint, 2=int, 3=float)');
console.log('nodata value:  ', img.getGDALNoData());
console.log('size (km):     ', ((w * Math.abs(rx)) / 1000).toFixed(1), 'x', ((h * Math.abs(ry)) / 1000).toFixed(1), 'if map units are meters');
import { fromFile } from 'geotiff';
const img = await (await fromFile(process.argv[2])).getImage();
const [rx, ry] = img.getResolution();
console.log('pixels:     ', img.getWidth(), 'x', img.getHeight());
console.log('pixel size: ', Math.abs(rx), 'x', Math.abs(ry));
console.log('bbox:       ', img.getBoundingBox());
console.log('nodata:     ', img.getGDALNoData());
console.log('geo keys:   ', img.getGeoKeys());

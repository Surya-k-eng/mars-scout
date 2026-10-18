import { fromFile } from 'geotiff';
for (const f of process.argv.slice(2)) {
  const img = await (await fromFile(f)).getImage();
  const d = img.getFileDirectory();
  console.log('=====', f.split(/[\\/]/).pop());
  console.log('geo keys:', img.getGeoKeys());
  console.log('GeoAsciiParams:', d.GeoAsciiParams);
  console.log('tiepoint:', d.ModelTiepoint, ' pixel scale:', d.ModelPixelScale);
}

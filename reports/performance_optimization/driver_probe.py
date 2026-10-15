from probe import *
for label,flags in [('driver-default',()),('driver-no-gpu-raster',('--disable-gpu-rasterization',)),('driver-angle-gl',('--use-angle=gl',))]:
 p=Probe(full=True,flags=flags)
 try:
  (OUT/(label+'-gpu.json')).write_text(json.dumps(p.call('/gpuinfo'),ensure_ascii=False,indent=2),encoding='utf-8')
  p.measure(label,seconds=8)
 finally:p.close()

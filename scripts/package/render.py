"""Caption and encode a credential-free Playwright recording; no external media."""
import json, subprocess, sys, textwrap
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
out = Path(sys.argv[1]).resolve()
recording = json.loads((out / 'recording.json').read_text())
font_path = '/System/Library/Fonts/Supplemental/Arial.ttf'
def font(size): return ImageFont.truetype(font_path, size)
def run(args): subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
raw = str(out / recording['video'])
probe = json.loads(subprocess.check_output(['ffprobe','-v','quiet','-show_format','-of','json',raw]))
duration = float(probe['format']['duration'])
scenes = recording['scenes']; parts=[]; subtitles=[]; cursor=0
for i, s in enumerate(scenes):
    start = s['at'] if i else 0
    end = scenes[i+1]['at'] if i+1<len(scenes) else duration
    length=max(.1,end-start)
    img=Image.new('RGB',(1280,120),'#101e35'); draw=ImageDraw.Draw(img)
    draw.text((26,12),s['title'],font=font(27),fill='#99b5ff')
    for j,line in enumerate(textwrap.wrap(s['caption'],100)):
        draw.text((26,48+j*30),line,font=font(23),fill='white')
    cap=out/f'caption-{i}.png';img.save(cap)
    dest=out/f'part-{i:02}.mp4'
    run(['ffmpeg','-y','-ss',str(start),'-t',str(length),'-i',raw,'-loop','1','-i',str(cap),'-filter_complex','[0:v]scale=1066:600,pad=1280:720:107:0:color=white[v];[v][1:v]overlay=0:600','-t',str(length),'-r','25','-c:v','libx264','-preset','fast','-crf','21','-pix_fmt','yuv420p','-an',str(dest)])
    parts.append(dest);subtitles.append((cursor,cursor+length,s['title']+' — '+s['caption']));cursor+=length
cards=[('Verified separately in real sandbox', ['Real Workers AI plan: three successful MCP calls','Replay: no additional usage','One final capture: USD 0.90','Zero-use session: authorization voided','Six genuine PayPal webhook events verified and applied','October 19 evidence; this card is not live checkout footage'],12),('Try Tollbooth', ['tollbooth.arcsolve.workers.dev','/run/rehearsal  •  /demo/merchant  •  /judge','Sandbox only. Human consent. Durable usage ledger.','Free quotas and cold CPU limits apply.','Live webhook redelivery proof remains pending.'],8)]
for j,(title,lines,length) in enumerate(cards):
    img=Image.new('RGB',(1280,720),'#101e35');d=ImageDraw.Draw(img);d.rectangle((62,67,70,139),fill='#416eff');d.text((96,82),title,font=font(42),fill='white')
    for k,line in enumerate(lines):d.text((96,208+k*63),line,font=font(27),fill='#dce6ff')
    path=out/f'card-{j}.png';img.save(path);dest=out/f'card-{j}.mp4'
    run(['ffmpeg','-y','-loop','1','-i',str(path),'-t',str(length),'-r','25','-c:v','libx264','-preset','fast','-crf','21','-pix_fmt','yuv420p',str(dest)])
    parts.append(dest);subtitles.append((cursor,cursor+length,title+'. '+'. '.join(lines)));cursor+=length
concat=out/'concat.txt';concat.write_text(''.join("file '"+str(p).replace("'","'\\''")+"'\n" for p in parts))
run(['ffmpeg','-y','-f','concat','-safe','0','-i',str(concat),'-c','copy','-movflags','+faststart',str(out/'demo.mp4')])
def stamp(t):
    ms=round(t*1000);h,ms=divmod(ms,3600000);m,ms=divmod(ms,60000);s,ms=divmod(ms,1000);return f'{h:02}:{m:02}:{s:02},{ms:03}'
(out/'demo.srt').write_text('\n'.join(f'{i+1}\n{stamp(a)} --> {stamp(b)}\n{text}\n' for i,(a,b,text) in enumerate(subtitles)))
metadata=json.loads(subprocess.check_output(['ffprobe','-v','quiet','-show_format','-show_streams','-of','json',str(out/'demo.mp4')]))
assert float(metadata['format']['duration'])<=170
assert metadata['streams'][0]['width']==1280 and metadata['streams'][0]['height']==720
(out/'video-metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
print('Video rendered:',round(float(metadata['format']['duration']),2),'seconds, 1280x720')

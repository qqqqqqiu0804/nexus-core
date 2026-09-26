import sys
sys.path.insert(0, '/root/nexus-core/server/tools')
from video_db import VideoDB
d = VideoDB('/root/nexus-core/server/videos.db')
s = d.stats()
print('videos      ', s['videos'])
print('transcribed ', s['transcribed'])
print('summarized  ', s['summarized'])
print('asr_hours   %.3f' % (s['asr_seconds_total'] / 3600))
print('collections ', s['collections'])
d.close()

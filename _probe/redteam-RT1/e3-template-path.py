# RT1-E3: 只读验证 visual_locate.template_path_for 是否接受绝对路径/穿越（不读图、不截图）
import sys, os
sys.path.insert(0, r'<project-root>/pet-runtime/tools')
import visual_locate as vl

for name in ['normal_button', r'..\..\..\Windows\win.ini', 'C:/Windows/win.ini',
             '<project-root>/pet-runtime/knowledge/templates/../../../../config.json',
             'CON', 'NUL']:
    try:
        print(repr(name), '->', vl.template_path_for(name))
    except Exception as e:
        print(repr(name), '-> ERROR', e)
print('TEMPLATE_DIR =', vl.TEMPLATE_DIR)

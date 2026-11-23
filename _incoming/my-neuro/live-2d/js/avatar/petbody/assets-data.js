// 由 pet-runtime/desktop/asset-toggles.mjs 自动导出，请勿手改。
// 生成命令见 pet-runtime/tools/gen-assets-data.mjs
window.__PET_ASSETS = {
  "version": 1,
  "groups": [
    {
      "id": "clothes",
      "label": "服饰"
    },
    {
      "id": "form",
      "label": "形态"
    },
    {
      "id": "glasses",
      "label": "眼镜"
    },
    {
      "id": "headwear",
      "label": "头饰"
    },
    {
      "id": "gesture",
      "label": "手势"
    },
    {
      "id": "expression",
      "label": "表情件"
    }
  ],
  "presets": [
    {
      "id": "maid",
      "label": "女仆装",
      "description": "皮套原样：短裙 + 穿鞋 + 有尾巴",
      "assets": {}
    },
    {
      "id": "home",
      "label": "居家",
      "description": "短裙 + 脱鞋 + 无尾巴",
      "assets": {
        "clothes-skirt": true,
        "clothes-shoes": true,
        "clothes-tail": false
      }
    },
    {
      "id": "show",
      "label": "演出",
      "description": "黑框眼镜 + 短裙",
      "assets": {
        "glasses-frame": true,
        "clothes-skirt": true
      }
    },
    {
      "id": "slack",
      "label": "摸鱼",
      "description": "大钢盆 + 中鱼",
      "assets": {
        "headwear-pot": true,
        "form-size": "mid"
      }
    }
  ],
  "assets": [
    {
      "id": "clothes-skirt",
      "label": "长短裙",
      "group": "clothes",
      "groupLabel": "服饰",
      "param": "Clothes1",
      "kind": "toggle",
      "default": 1,
      "exclusive": null,
      "aliases": [
        "裙子",
        "裙长",
        "短裙",
        "长裙",
        "裙子切换"
      ],
      "note": "开=短裙（默认），关=长裙；对应皮套表情「裙子切换」。",
      "onLabel": "短裙",
      "offLabel": "长裙",
      "options": null
    },
    {
      "id": "clothes-chest",
      "label": "胸口衣服",
      "group": "clothes",
      "groupLabel": "服饰",
      "param": "Clothes3",
      "kind": "toggle",
      "default": 0,
      "exclusive": null,
      "aliases": [
        "胸口",
        "胸衣",
        "上衣"
      ],
      "note": "开=胸口多一层衣服（遮得更多），关=皮套原本的样子。",
      "onLabel": "加层",
      "offLabel": "默认",
      "options": null
    },
    {
      "id": "clothes-shoes",
      "label": "脱鞋",
      "group": "clothes",
      "groupLabel": "服饰",
      "param": "Clothes4",
      "kind": "toggle",
      "default": 0,
      "exclusive": null,
      "aliases": [
        "鞋子",
        "鞋",
        "脱鞋",
        "光脚"
      ],
      "note": "开=脱鞋（光脚），关=穿鞋（默认）；对应皮套表情「脱鞋」。",
      "onLabel": "光脚",
      "offLabel": "穿鞋",
      "options": null
    },
    {
      "id": "clothes-tail",
      "label": "尾巴",
      "group": "clothes",
      "groupLabel": "服饰",
      "param": "Clothes5",
      "kind": "toggle",
      "default": 1,
      "exclusive": null,
      "aliases": [
        "鲸尾",
        "尾",
        "尾巴开关"
      ],
      "note": "开=有鲸鱼尾巴（默认），关=收起来；对应皮套表情「尾巴开关」。",
      "onLabel": "有尾巴",
      "offLabel": "无尾巴",
      "options": null
    },
    {
      "id": "form-size",
      "label": "大小变",
      "group": "form",
      "groupLabel": "形态",
      "param": "Clothes2",
      "kind": "cycle",
      "default": 0,
      "exclusive": null,
      "aliases": [
        "体型",
        "大小",
        "大鱼",
        "中鱼",
        "小鱼",
        "size"
      ],
      "note": "大鱼=0（默认体型）/ 中鱼=0.4（体型1）/ 小鱼=1（体型2）；按一次切下一档。",
      "onLabel": "",
      "offLabel": "",
      "options": [
        {
          "id": "big",
          "label": "大鱼",
          "value": 0
        },
        {
          "id": "mid",
          "label": "中鱼",
          "value": 0.4
        },
        {
          "id": "small",
          "label": "小鱼",
          "value": 1
        }
      ]
    },
    {
      "id": "glasses-frame",
      "label": "黑框眼镜",
      "group": "glasses",
      "groupLabel": "眼镜",
      "param": "key11",
      "kind": "toggle",
      "default": 0,
      "exclusive": "glasses",
      "aliases": [
        "眼镜",
        "黑框"
      ],
      "note": "与单片眼镜互斥。",
      "onLabel": "戴上",
      "offLabel": "摘下",
      "options": null
    },
    {
      "id": "glasses-monocle",
      "label": "单片眼镜",
      "group": "glasses",
      "groupLabel": "眼镜",
      "param": "key12",
      "kind": "toggle",
      "default": 0,
      "exclusive": "glasses",
      "aliases": [
        "单片",
        "单片镜"
      ],
      "note": "与黑框眼镜互斥。",
      "onLabel": "戴上",
      "offLabel": "摘下",
      "options": null
    },
    {
      "id": "headwear-pot",
      "label": "大钢盆",
      "group": "headwear",
      "groupLabel": "头饰",
      "param": "key10",
      "kind": "toggle",
      "default": 0,
      "exclusive": null,
      "aliases": [
        "钢盆",
        "铁盆",
        "盆",
        "锅"
      ],
      "note": "扣上后钢盆会遮住眼睛和脸的上半部分，是皮套原样的效果。",
      "onLabel": "扣上",
      "offLabel": "取下",
      "options": null
    },
    {
      "id": "gesture-grass",
      "label": "狗尾草",
      "group": "gesture",
      "groupLabel": "手势",
      "param": "Movement1",
      "kind": "toggle",
      "default": 0,
      "exclusive": "gesture",
      "aliases": [
        "狗尾巴草",
        "草",
        "狗尾草"
      ],
      "note": "手里出现一根狗尾草；与抚胸、竖食指互斥。",
      "onLabel": "拿出草",
      "offLabel": "收起",
      "options": null
    },
    {
      "id": "gesture-chest",
      "label": "抚胸",
      "group": "gesture",
      "groupLabel": "手势",
      "param": "Movement2",
      "kind": "toggle",
      "default": 0,
      "exclusive": "gesture",
      "aliases": [
        "手抚胸",
        "捂胸口",
        "抚胸"
      ],
      "note": "手放在胸口；与狗尾草、竖食指互斥。",
      "onLabel": "抚胸",
      "offLabel": "放下",
      "options": null
    },
    {
      "id": "gesture-finger",
      "label": "竖食指",
      "group": "gesture",
      "groupLabel": "手势",
      "param": "Movement3",
      "kind": "toggle",
      "default": 0,
      "exclusive": "gesture",
      "aliases": [
        "竖手指",
        "食指",
        "竖指"
      ],
      "note": "竖起食指；与狗尾草、抚胸互斥。",
      "onLabel": "竖起",
      "offLabel": "放下",
      "options": null
    },
    {
      "id": "face-black",
      "label": "黑脸",
      "group": "expression",
      "groupLabel": "表情件",
      "param": "key1",
      "kind": "toggle",
      "default": 0,
      "exclusive": null,
      "aliases": [
        "黑化",
        "阴沉"
      ],
      "note": "额头压下一片阴影。",
      "onLabel": "阴下脸",
      "offLabel": "正常",
      "options": null
    },
    {
      "id": "face-tears",
      "label": "落泪",
      "group": "expression",
      "groupLabel": "表情件",
      "param": "key2",
      "kind": "toggle",
      "default": 0,
      "exclusive": null,
      "aliases": [
        "流泪",
        "哭泣",
        "眼泪",
        "哭"
      ],
      "note": "",
      "onLabel": "哭了",
      "offLabel": "正常",
      "options": null
    },
    {
      "id": "eyes-dizzy",
      "label": "圈圈眼",
      "group": "expression",
      "groupLabel": "表情件",
      "param": "key3",
      "kind": "toggle",
      "default": 0,
      "exclusive": "eyes",
      "aliases": [
        "晕",
        "晕倒",
        "蚊香眼"
      ],
      "note": "眼睛变白色圈圈；与爱心眼 / ＞＜眼 / 屑屑眼互斥。",
      "onLabel": "晕了",
      "offLabel": "正常",
      "options": null
    },
    {
      "id": "eyes-heart",
      "label": "爱心眼",
      "group": "expression",
      "groupLabel": "表情件",
      "param": "key4",
      "kind": "toggle",
      "default": 0,
      "exclusive": "eyes",
      "aliases": [
        "心心眼",
        "花痴",
        "心动"
      ],
      "note": "与圈圈眼 / ＞＜眼 / 屑屑眼互斥。",
      "onLabel": "心动",
      "offLabel": "正常",
      "options": null
    },
    {
      "id": "eyes-squint",
      "label": "＞＜眼",
      "group": "expression",
      "groupLabel": "表情件",
      "param": "key5",
      "kind": "toggle",
      "default": 0,
      "exclusive": "eyes",
      "aliases": [
        "＞＜",
        "><",
        "龇牙笑",
        "眯眼笑"
      ],
      "note": "与圈圈眼 / 爱心眼 / 屑屑眼互斥。",
      "onLabel": "闭眼笑",
      "offLabel": "正常",
      "options": null
    },
    {
      "id": "eyes-smug",
      "label": "屑屑眼",
      "group": "expression",
      "groupLabel": "表情件",
      "param": "key6",
      "kind": "toggle",
      "default": 0,
      "exclusive": "eyes",
      "aliases": [
        "不屑",
        "得意",
        "鄙视"
      ],
      "note": "与圈圈眼 / 爱心眼 / ＞＜眼互斥。",
      "onLabel": "不屑",
      "offLabel": "正常",
      "options": null
    },
    {
      "id": "face-blush",
      "label": "脸红",
      "group": "expression",
      "groupLabel": "表情件",
      "param": "key7",
      "kind": "toggle",
      "default": 0,
      "exclusive": null,
      "aliases": [
        "害羞",
        "羞红",
        "脸红"
      ],
      "note": "",
      "onLabel": "害羞",
      "offLabel": "正常",
      "options": null
    },
    {
      "id": "face-loading",
      "label": "加载",
      "group": "expression",
      "groupLabel": "表情件",
      "param": "key8",
      "kind": "toggle",
      "default": 0,
      "exclusive": null,
      "aliases": [
        "loading",
        "读取",
        "卡住",
        "加载中"
      ],
      "note": "头顶出现一圈加载转圈。",
      "onLabel": "读取中",
      "offLabel": "正常",
      "options": null
    },
    {
      "id": "face-fang",
      "label": "大牙",
      "group": "expression",
      "groupLabel": "表情件",
      "param": "key9",
      "kind": "toggle",
      "default": 0,
      "exclusive": null,
      "aliases": [
        "虎牙",
        "龅牙",
        "牙"
      ],
      "note": "",
      "onLabel": "露牙",
      "offLabel": "正常",
      "options": null
    },
    {
      "id": "face-sweat",
      "label": "流冷汗",
      "group": "expression",
      "groupLabel": "表情件",
      "param": "key13",
      "kind": "toggle",
      "default": 0,
      "exclusive": null,
      "aliases": [
        "冷汗",
        "汗",
        "尴尬"
      ],
      "note": "",
      "onLabel": "尴尬",
      "offLabel": "正常",
      "options": null
    }
  ]
};

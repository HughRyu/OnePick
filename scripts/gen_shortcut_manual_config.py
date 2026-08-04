#!/usr/bin/env python3
# OnePick Shortcut v17: share/clipboard plain-text input, signed distribution artifact, and direct Photos import.
import plistlib, uuid
from pathlib import Path

def U(): return str(uuid.uuid4()).upper()
def plain(s): return {"Value":{"string":s,"attachmentsByRange":{}},"WFSerializationType":"WFTextTokenString"}
def var_attach(name): return {"Value":{"Type":"Variable","VariableName":name},"WFSerializationType":"WFTextTokenAttachment"}
def out_attach(uid, name): return {"Value":{"OutputUUID":uid,"OutputName":name,"Type":"ActionOutput"},"WFSerializationType":"WFTextTokenAttachment"}
def tok_vars(template, pairs):
    att={}
    for pos,typ,ref,outname in pairs:
        att[f"{{{pos}, 1}}"]={"Type":"Variable","VariableName":ref} if typ=='var' else {"OutputUUID":ref,"OutputName":outname,"Type":"ActionOutput"}
    return {"Value":{"string":template,"attachmentsByRange":att},"WFSerializationType":"WFTextTokenString"}
def action(a,p=None): return {"WFWorkflowActionIdentifier":a,"WFWorkflowActionParameters":p or {}}
def comment(t): return action("is.workflow.actions.comment",{"WFCommentActionText":t})
def text(uid,s): return action("is.workflow.actions.gettext",{"UUID":uid,"WFTextActionText":plain(s)})
def setv(name, uid, out): return action("is.workflow.actions.setvariable",{"WFVariableName":name,"WFInput":out_attach(uid,out)})
def cond(gid,var='',needle='',mode=0):
    p={"GroupingIdentifier":gid,"WFControlFlowMode":mode}
    if mode==0: p.update({"WFCondition":4,"WFConditionalActionString":needle,"WFInput":{"Type":"Variable","Variable":var_attach(var)}})
    return action("is.workflow.actions.conditional",p)
def ask(uid,prompt): return action("is.workflow.actions.ask",{"UUID":uid,"WFAskActionPrompt":plain(prompt)})
def alert(msg): return action("is.workflow.actions.alert",{"WFAlertActionTitle":plain("OnePick"),"WFAlertActionMessage":plain(msg),"WFAlertActionCancelButtonShown":False})
VIBRATE=action("is.workflow.actions.vibrate")
EXIT=action("is.workflow.actions.exit")
A=[]
A.append(comment("OnePick 视频下载 v17\n修复 iOS/X 分享下载空白页：分享输入与剪贴板只按纯文本交给后端；响应媒体直接存入相册。\n配置：导入时粘贴 onepick-config|服务器|token；可从 OnePick 账户页复制。凭据轮换后请重新导入或更新配置。"))
# import-time fallback config
u_cfg=U(); cfg_idx=len(A); A.append(text(u_cfg,"onepick-config|https://onepick.download.com:8088|apikey.PASTE_TOKEN_HERE")); A.append(setv("OP_CFG",u_cfg,"文本"))
uv=U(); A.append(text(uv,"on")); A.append(setv("OP_VIBRATE",uv,"文本"))
# clipboard text
ucb=U(); A.append(action("is.workflow.actions.getclipboard",{"UUID":ucb})); A.append(setv("OP_CLIP_RAW",ucb,"剪贴板"))
uct=U(); A.append(action("is.workflow.actions.gettext",{"UUID":uct,"WFTextActionText":tok_vars("\ufffc",[(0,'var',"OP_CLIP_RAW",None)])})); A.append(setv("OP_CLIP",uct,"文本"))
# if clipboard has config, use it; else if import placeholder, ask config
Gc=U(); A.append(cond(Gc,"OP_CLIP","onepick-config|",0)); A.append(action("is.workflow.actions.setvariable",{"WFVariableName":"OP_CFG","WFInput":var_attach("OP_CLIP")})); A.append(cond(Gc,mode=1)); Gp=U(); A.append(cond(Gp,"OP_CFG","PASTE_TOKEN_HERE",0)); uaskcfg=U(); A.append(ask(uaskcfg,"粘贴 OnePick 配置（一整段 onepick-config|服务器|token）")); A.append(setv("OP_CFG",uaskcfg,"询问")); A.append(cond(Gp,mode=2)); A.append(cond(Gc,mode=2))
# share input
A.append(action("is.workflow.actions.setvariable",{"WFVariableName":"OP_SHARE","WFInput":{"Value":{"Type":"ExtensionInput"},"WFSerializationType":"WFTextTokenAttachment"}}))
# split config
us=U(); A.append(action("is.workflow.actions.text.split",{"UUID":us,"text":tok_vars("\ufffc",[(0,'var',"OP_CFG",None)]),"WFTextSeparator":"Custom","WFTextCustomSeparator":"|"}))
usrv=U(); A.append(action("is.workflow.actions.getitemfromlist",{"UUID":usrv,"WFInput":out_attach(us,"拆分文本"),"WFItemSpecifier":"Item At Index","WFItemIndex":2})); A.append(setv("OP_SERVER",usrv,"列表项"))
utok=U(); A.append(action("is.workflow.actions.getitemfromlist",{"UUID":utok,"WFInput":out_attach(us,"拆分文本"),"WFItemSpecifier":"Item At Index","WFItemIndex":3})); A.append(setv("OP_TOKEN",utok,"列表项"))
# link/input: pass only plain text. Rich detect.link output can serialize as a blank JSON value.
ulink=U(); A.append(action("is.workflow.actions.gettext",{"UUID":ulink,"WFTextActionText":tok_vars("分享输入：\ufffc\n剪贴板文本：\ufffc",[(5,'var',"OP_SHARE",None),(13,'var',"OP_CLIP",None)])})); A.append(setv("OP_LINK",ulink,"文本"))
# request
mid="/api/shortcut/download?token="
uurl=U(); A.append(action("is.workflow.actions.gettext",{"UUID":uurl,"WFTextActionText":tok_vars("\ufffc"+mid+"\ufffc",[(0,'var',"OP_SERVER",None),(1+len(mid),'var',"OP_TOKEN",None)])})); A.append(setv("OP_URL",uurl,"文本"))
unet=U(); A.append(action("is.workflow.actions.downloadurl",{"UUID":unet,"WFURL":tok_vars("\ufffc",[(0,'var',"OP_URL",None)]),"WFHTTPMethod":"POST","WFHTTPBodyType":"JSON","WFJSONValues":{"Value":{"WFDictionaryFieldValueItems":[{"WFItemType":0,"WFKey":plain("input"),"WFValue":tok_vars("\ufffc",[(0,'var',"OP_LINK",None)])}]},"WFSerializationType":"WFDictionaryFieldValue"}})); A.append(setv("OP_MEDIA",unet,"内容"))
ut=U(); A.append(action("is.workflow.actions.gettext",{"UUID":ut,"WFTextActionText":tok_vars("\ufffc",[(0,'var',"OP_MEDIA",None)])})); A.append(setv("OP_RESP",ut,"文本"))
gs=U(); A.append(cond(gs,"OP_RESP","\"error\"",0)); gv=U(); A.append(cond(gv,"OP_VIBRATE","on",0)); A.append(VIBRATE); A.append(VIBRATE); A.append(cond(gv,mode=2)); A.append(alert("下载失败 ⚠️\n请检查配置、链接、Cookie 或代理。")); A.append(cond(gs,mode=1)); A.append(action("is.workflow.actions.savetocameraroll",{"WFInput":var_attach("OP_MEDIA")})); gv2=U(); A.append(cond(gv2,"OP_VIBRATE","on",0)); A.append(VIBRATE); A.append(cond(gv2,mode=2)); A.append(cond(gs,mode=2))
workflow={"WFWorkflowActions":A,"WFWorkflowClientVersion":"2607.1.3","WFWorkflowMinimumClientVersion":900,"WFWorkflowMinimumClientVersionString":"900","WFWorkflowHasOutputFallback":False,"WFWorkflowHasShortcutInputVariables":True,"WFWorkflowName":"OnePick 视频下载 v17","WFWorkflowIcon":{"WFWorkflowIconStartColor":431817727,"WFWorkflowIconGlyphNumber":59717},"WFWorkflowImportQuestions":[{"ActionIndex":cfg_idx,"Category":"Parameter","ParameterKey":"WFTextActionText","Text":"粘贴 OnePick 配置（一整段；若剪贴板有正确配置也会自动使用）","DefaultValue":"onepick-config|https://onepick.download.com:8088|apikey.PASTE_TOKEN_HERE"}],"WFWorkflowInputContentItemClasses":["WFStringContentItem","WFURLContentItem","WFSafariWebPageContentItem","WFRichTextContentItem","WFGenericFileContentItem"],"WFWorkflowTypes":["ActionExtension","NCWidget"]}
out=Path('/tmp/onepick_import_config.shortcut')
plistlib.dump(workflow,out.open('wb'),fmt=plistlib.FMT_XML)
print('written',out,'actions',len(A),'cfg_idx',cfg_idx)

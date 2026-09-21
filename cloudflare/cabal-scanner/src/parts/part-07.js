        btcReference:stage.btcReference,
        whaleInjection:[...whaleInjectedBases],
        whaleFeed:{
          ok:whaleFeed.ok,
          status:whaleFeed.status,
          reason:whaleFeed.reason,
          candidates:whaleFeed.candidates
        },
        candidates:final,
        runtimeMs:Date.now()-started
      };

      return new Response(JSON.stringify(response,null,2), {
        headers:{
          "content-type":"application/json; charset=utf-8",
          "cache-control":"no-store"
        }
      });
    }catch(e){
      return new Response(JSON.stringify({
        ok:false,
        patchVersion:PATCH_VERSION,
        error:String(e),
        generatedAt:new Date().toISOString()
      },null,2), {
        status:500,
        headers:{"content-type":"application/json; charset=utf-8"}
      });
    }
  }
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==="/health"){
      const h=await guardHealth(env);
      return new Response(JSON.stringify(h,null,2),{
        status:200,
        headers:{
          "content-type":"application/json; charset=utf-8",
          "cache-control":"no-store"
        }
      });
    }
    return handleScan(request,env);
  },

  async scheduled(event,env,ctx){
    ctx.waitUntil(runMarketGuard(event,env));
  }
};

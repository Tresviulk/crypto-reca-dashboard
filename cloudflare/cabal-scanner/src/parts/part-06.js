          const preferred = c._liteMarket || null;
          const [x15,x240] = await Promise.all([
            klineWithFallback(c,"15",50,deduped.byBase,preferred),
            klineWithFallback(c,"240",50,deduped.byBase,preferred)
          ]);

          // Reuse the already-fetched 1h lite series. This saves one subrequest per full-deep target.
          const a60 = c._liteBars || [];
          const source60 = preferred;
          if(!a60.length) throw new Error("MISSING_LITE_1H_SERIES");

          const d = deepAnalysis(x15.bars,a60,x240.bars);
          const lite = deepLiteAnalysis(a60,c) || c.lite;
          const classification = classify(c,d,lite);

          return Object.assign({},c,{
            lite,
            deep:d,
            classification,
            deepValidation:"FULL_OK",
            deepValidationSources:{
              m15:x15.market.venue,
              h1:source60 ? source60.venue : c.deepValidationSource,
              h4:x240.market.venue
            }
          });
        }catch(e){
          const classification = classify(c,null,c.lite);
          return Object.assign({},c,{
            classification,
            deepValidation:"LITE_ONLY",
            fullDeepError:String(e)
          });
        }
      });

      const liteMap = new Map(liteResults.map(x=>[x.base,x]));
      const fullMap = new Map(fullResults.map(x=>[x.base,x]));

      let final = stage.candidates.map(c=>{
        if(fullMap.has(c.base)) return fullMap.get(c.base);
        if(liteMap.has(c.base)){
          const x = liteMap.get(c.base);
          return Object.assign({},x,{classification:classify(x,null,x.lite)});
        }
        return Object.assign({},c,{
          classification:c.microcapAnomaly ? "MICROCAP ANOMALY WATCH" : ((c.bucketHits || []).includes("E") ? "SECOND-LEG WATCH — PENDING DEEP" : ((c.bucketHits || []).includes("T") ? "TURNOVER ANOMALY WATCH" : "NO SETUP")),
          deepValidation:"NOT_SELECTED"
        });
      });

      // Remove private helper fields before response.
      final = final.map(x=>{
        const y = Object.assign({},x);
        delete y._liteMarket;
        delete y._liteBars;
        return y;
      });

      // CABAL -> WHALES: only the highest priority qualifying assets are sent to the external whale engine.
      const whaleCandidates = final
        .filter(isWhaleTrigger)
        .sort((a,b)=>fullDeepPriority(b)-fullDeepPriority(a))
        .slice(0,MAX_WHALE_REQUESTS);

      const whaleResults = await mapLimit(whaleCandidates,2,async c=>({
        base:c.base,
        whales:await runWhaleDeep(env,c)
      }));
      const whaleMap = new Map(whaleResults.map(x=>[x.base,x.whales]));

      final = final.map(c=>Object.assign({},c,{
        whales:whaleMap.get(c.base) || (isWhaleTrigger(c)
          ? {requested:true,status:env.WHALES_DEEP_URL ? "QUEUED_LIMIT" : "WHALE DATA GAP",reason:env.WHALES_DEEP_URL ? "MAX_WHALE_REQUESTS_REACHED" : "WHALES_DEEP_URL_NOT_CONFIGURED"}
          : {requested:false,status:"NOT_TRIGGERED"})
      }));

      const sourceErrors = {
        bybit:sourceResults[0].status === "rejected" ? String(sourceResults[0].reason) : null,
        kucoin:sourceResults[1].status === "rejected" ? String(sourceResults[1].reason) : null,
        coinGecko:sourceResults[2].status === "rejected" ? String(sourceResults[2].reason) : null,
        tradingView:tv.errors
      };

      const marketCorePass = (bybit.length || kucoin.length) && tv.rows.length > 0;
      const whalesConfigured = !!env.WHALES_DEEP_URL && !!env.WHALES_DEEP_TOKEN;
      const whalesBidirectional = whalesConfigured && whaleFeed.ok;
      const coverageStatus = marketCorePass && whalesBidirectional ? "PASS" : "PARTIAL";

      const response = {
        ok:true,
        patchVersion:PATCH_VERSION,
        generatedAt:new Date().toISOString(),
        coverage:{
          bucketA:marketCorePass ? "PASS" : "PARTIAL",
          bucketB:marketCorePass ? "PASS" : "PARTIAL",
          bucketC:marketCorePass ? "PASS" : "PARTIAL",
          bucketD:"EXTERNAL_STAGE0_REQUIRED",
          bucketE:"PASS_SECOND_LEG_PRECURSOR_PLUS_1H_DEEP",
          turnoverAnomaly:"PASS",
          multiVenue:"BYBIT+KUCOIN",
          whales:whalesBidirectional
            ? "BIDIRECTIONAL_CONNECTED"
            : (whalesConfigured ? "DEEP_ONLY_PARTIAL" : "WHALE DATA GAP"),
          whaleFeedStatus:whaleFeed.status,
          whaleFeedReason:whaleFeed.reason,
          coverageStatus
        },
        sources:{
          bybitSpotRows:bybit.length,
          kucoinSpotRows:kucoin.length,
          dedupedSpotBases:deduped.preferred.length,
          tradingViewStatus:tv.status,
          tradingViewRows:tv.rows.length,
          tradingViewChunks:Math.ceil(scanUniverse.length/TV_CHUNK_SIZE),
          coinGeckoConfigured:cg.configured,
          coinGeckoStatus:cg.status,
          coinGeckoRows:cg.rows.length,
          whaleFeedStatus:whaleFeed.status,
          whaleFeedCandidates:whaleFeed.candidates.length,
          errors:sourceErrors
        },
        truncation:{
          scanUniverseTotal,
          scanUniverseUsed:scanUniverse.length,
          scanUniverseTruncated:scanUniverseTotal > scanUniverse.length,
          stageAAllCandidateCount:stage.allCandidateCount,
          stageARetained:stage.candidates.length,
          stageATruncated:stage.stageATruncated,
          deepLiteRequested:deepTargets.length,
          deepLiteCap:MAX_DEEP_LITE,
          deepLiteTruncated:stage.candidates.length > deepTargets.length,
          fullDeepRequested:fullTargets.length,
          fullDeepCap:MAX_FULL_DEEP,
          fullDeepTruncated:liteResults.filter(x=>x.lite).length > fullTargets.length,
          whaleRequests:whaleCandidates.length,
          whaleRequestCap:MAX_WHALE_REQUESTS
        },
        counts:{
          scannedStageAUniverse:scanUniverse.length,
          candidateCountStageA:stage.candidates.length,
          candidateCountBeforeRetention:stage.allCandidateCount,
          laneCountsBeforeRetention:stage.allLaneCounts,
          deepLiteCompleted:liteResults.filter(x=>x.lite).length,
          deepValidatedCount:fullResults.filter(x=>x.deep).length,
          whaleDeepTriggered:final.filter(x=>x.whales && x.whales.requested).length,
          whaleInjectedCount:whaleInjectedBases.size,
          whaleFeedCandidateCount:whaleFeed.candidates.length,
          manualWhaleInjectedCount:manualWhaleInjectedBases.size
        },

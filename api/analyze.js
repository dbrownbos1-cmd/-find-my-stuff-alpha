export default async function handler(req,res){
  if(req.method!=="POST") return res.status(405).json({error:"Use POST"});
  try{
    const key=process.env.OPENAI_API_KEY;
    if(!key) return res.status(500).json({error:"OPENAI_API_KEY is not configured"});
    const image=req.body?.image;
    if(!image || typeof image!=="string") return res.status(400).json({error:"Missing image"});

    const prompt=`You are identifying household objects visible in one photo for a personal inventory app. Return only concrete, useful item names that a person could later search for. Be specific when confident, avoid duplicates, and do not invent obscured items.`;
    const r=await fetch("https://api.openai.com/v1/responses",{
      method:"POST",
      headers:{"Authorization":`Bearer ${key}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        model:"gpt-4.1-mini",
        input:[{role:"user",content:[
          {type:"input_text",text:prompt},
          {type:"input_image",image_url:image}
        ]}],
        text:{format:{type:"json_schema",name:"inventory_items",strict:true,schema:{type:"object",properties:{items:{type:"array",items:{type:"string"}}},required:["items"],additionalProperties:false}}}
      })
    });
    const raw=await r.text();
    let data={};
    try{data=raw?JSON.parse(raw):{}}catch{}
    if(!r.ok) return res.status(r.status).json({error:data?.error?.message||data?.error||"OpenAI request failed"});

    let parsed=null;
    for(const out of data.output||[]){
      for(const c of out.content||[]){
        if(c.type==="output_text" && c.text){
          try{parsed=JSON.parse(c.text)}catch{}
        }
      }
    }
    if(!parsed && data.output_text){
      try{parsed=JSON.parse(data.output_text)}catch{}
    }
    const items=(parsed?.items||[]).map(x=>String(x).trim()).filter(Boolean);
    return res.status(200).json({items});
  }catch(err){
    console.error(err);
    return res.status(500).json({error:err?.message||"Analysis failed"});
  }
}
